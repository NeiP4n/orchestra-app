/**
 * Two-way RPC bridge client for Zen Browser extension
 * Connects via WebSocket to Orchestra daemon (ws://127.0.0.1:4097)
 * With automatic HTTP Long-Poll & Heartbeat fallback (http://127.0.0.1:4097)
 * Allows autonomous AI control: inspecting tabs, reading DOM, executing scripts, controlling media.
 */

export const DEFAULT_RPC_URL = "ws://127.0.0.1:4097"
export const DEFAULT_HTTP_FALLBACK_URL = "http://127.0.0.1:4097"
export const RECONNECT_INTERVAL_MS = 2000
export const HTTP_POLL_INTERVAL_MS = 1500
export const HEARTBEAT_INTERVAL_MS = 2000

export interface RpcRequest {
  readonly id: string | number
  readonly action: string
  readonly params?: Record<string, unknown>
}

export interface RpcResponse {
  readonly id: string | number
  readonly success: boolean
  readonly result?: unknown
  readonly error?: string
}

export interface AiActivityEvent {
  readonly action: string
  readonly summary: string
  readonly success: boolean
  readonly timestamp: number
}

export type BrowserLike = {
  tabs?: {
    query: (queryInfo: Record<string, unknown>) => Promise<
      Array<{
        id?: number
        title?: string
        url?: string
        active?: boolean
        audible?: boolean
        mutedInfo?: { muted?: boolean }
        muted?: boolean
      }>
    >
    update: (tabId: number, updateProperties: Record<string, unknown>) => Promise<unknown>
    create: (createProperties: Record<string, unknown>) => Promise<{ id?: number }>
    remove: (tabId: number) => Promise<void>
  }
  scripting?: {
    executeScript: (injection: {
      target: { tabId: number }
      func: (...args: unknown[]) => unknown
      args?: unknown[]
    }) => Promise<Array<{ result?: unknown }>>
  }
  runtime?: {
    sendMessage?: (message: unknown) => Promise<unknown>
  }
}

export function getBrowserApi(): BrowserLike | undefined {
  if (typeof globalThis === "undefined") return undefined
  const g = globalThis as unknown as { browser?: BrowserLike; chrome?: BrowserLike }
  return g.browser ?? g.chrome
}

/**
 * Resolve target tab ID: explicit tabId or current active tab.
 */
export async function resolveTargetTabId(browserApi: BrowserLike, tabId?: unknown): Promise<number> {
  if (typeof tabId === "number" && !Number.isNaN(tabId)) {
    return tabId
  }
  if (!browserApi.tabs?.query) {
    throw new Error("Tabs API unavailable")
  }
  const activeTabs = await browserApi.tabs.query({ active: true, currentWindow: true })
  const fallback = activeTabs[0] ?? (await browserApi.tabs.query({ active: true }))[0]
  if (!fallback?.id) {
    throw new Error("No active tab found")
  }
  return fallback.id
}

/**
 * Execute RPC command against browser APIs.
 */
export async function handleRpcAction(
  action: string,
  params: Record<string, unknown> = {},
  browserApi: BrowserLike = getBrowserApi() ?? {},
): Promise<unknown> {
  switch (action) {
    case "tabs": {
      if (!browserApi.tabs?.query) throw new Error("Tabs API unavailable")
      const list = await browserApi.tabs.query({})
      return list.map((t) => ({
        id: t.id,
        title: t.title ?? "",
        url: t.url ?? "",
        active: Boolean(t.active),
        audible: Boolean(t.audible),
        muted: Boolean(t.mutedInfo?.muted ?? t.muted),
      }))
    }

    case "read": {
      if (!browserApi.scripting?.executeScript) throw new Error("Scripting API unavailable")
      const tabId = await resolveTargetTabId(browserApi, params.tabId)
      const results = await browserApi.scripting.executeScript({
        target: { tabId },
        func: () => ({
          title: document.title,
          url: window.location.href,
          innerText: document.body ? document.body.innerText.slice(0, 50000) : "",
          selection: window.getSelection() ? String(window.getSelection()) : "",
        }),
      })
      return results?.[0]?.result
    }

    case "eval": {
      if (!browserApi.scripting?.executeScript) throw new Error("Scripting API unavailable")
      const code = typeof params.code === "string" ? params.code : ""
      if (!code) throw new Error("Code parameter required for eval")
      const tabId = await resolveTargetTabId(browserApi, params.tabId)
      const results = await browserApi.scripting.executeScript({
        target: { tabId },
        args: [code],
        func: (scriptCode: unknown) => {
          // eslint-disable-next-line no-eval
          return window.eval(String(scriptCode))
        },
      })
      return results?.[0]?.result
    }

    case "click": {
      if (!browserApi.scripting?.executeScript) throw new Error("Scripting API unavailable")
      const selector = typeof params.selector === "string" ? params.selector : ""
      if (!selector) throw new Error("Selector parameter required for click")
      const tabId = await resolveTargetTabId(browserApi, params.tabId)
      const results = await browserApi.scripting.executeScript({
        target: { tabId },
        args: [selector],
        func: (sel: unknown) => {
          const el = document.querySelector(String(sel)) as HTMLElement | null
          if (!el) throw new Error(`Element not found: ${String(sel)}`)
          el.click()
          return { clicked: true, tagName: el.tagName, text: el.textContent?.trim().slice(0, 100) }
        },
      })
      return results?.[0]?.result
    }

    case "type": {
      if (!browserApi.scripting?.executeScript) throw new Error("Scripting API unavailable")
      const selector = typeof params.selector === "string" ? params.selector : ""
      const text = typeof params.text === "string" ? params.text : typeof params.value === "string" ? params.value : ""
      if (!selector) throw new Error("Selector parameter required for type")
      const tabId = await resolveTargetTabId(browserApi, params.tabId)
      const results = await browserApi.scripting.executeScript({
        target: { tabId },
        args: [selector, text],
        func: (sel: unknown, val: unknown) => {
          const targetSelector = String(sel)
          const targetValue = String(val)
          const el = document.querySelector(targetSelector) as
            | HTMLInputElement
            | HTMLTextAreaElement
            | HTMLElement
            | null
          if (!el) throw new Error(`Input element not found: ${targetSelector}`)
          if ("value" in el) {
            el.value = targetValue
          } else {
            el.innerText = targetValue
          }
          el.dispatchEvent(new Event("input", { bubbles: true }))
          el.dispatchEvent(new Event("change", { bubbles: true }))
          return { typed: true, length: targetValue.length }
        },
      })
      return results?.[0]?.result
    }

    case "navigate": {
      if (!browserApi.tabs) throw new Error("Tabs API unavailable")
      const url = typeof params.url === "string" ? params.url : ""
      if (!url) throw new Error("URL parameter required for navigate")
      if (typeof params.tabId === "number") {
        return await browserApi.tabs.update(params.tabId, { url })
      }
      return await browserApi.tabs.create({ url })
    }

    case "activate": {
      if (!browserApi.tabs) throw new Error("Tabs API unavailable")
      const tabId = await resolveTargetTabId(browserApi, params.tabId)
      return await browserApi.tabs.update(tabId, { active: true })
    }

    case "close": {
      if (!browserApi.tabs) throw new Error("Tabs API unavailable")
      const tabId = await resolveTargetTabId(browserApi, params.tabId)
      await browserApi.tabs.remove(tabId)
      return { closed: true, tabId }
    }

    case "media": {
      if (!browserApi.scripting?.executeScript || !browserApi.tabs?.query) {
        throw new Error("Scripting/Tabs API unavailable")
      }
      const cmd =
        typeof params.action === "string"
          ? params.action
          : typeof params.command === "string"
            ? params.command
            : "toggle"
      let tabId: number
      if (typeof params.tabId === "number") {
        tabId = params.tabId
      } else {
        const audible = await browserApi.tabs.query({ audible: true })
        if (audible[0]?.id) {
          tabId = audible[0].id
        } else {
          tabId = await resolveTargetTabId(browserApi)
        }
      }

      const results = await browserApi.scripting.executeScript({
        target: { tabId },
        args: [cmd],
        func: (actionCmd: unknown) => {
          const command = String(actionCmd).toLowerCase()
          if (command === "next") {
            const nextBtn = document.querySelector(
              ".ytp-next-button, button[aria-label='Next'], [data-testid='control-button-skip-forward']",
            ) as HTMLElement | null
            if (nextBtn) {
              nextBtn.click()
              return { command: "next", handledByButton: true }
            }
          }
          if (command === "prev") {
            const prevBtn = document.querySelector(
              ".ytp-prev-button, button[aria-label='Previous'], [data-testid='control-button-skip-back']",
            ) as HTMLElement | null
            if (prevBtn) {
              prevBtn.click()
              return { command: "prev", handledByButton: true }
            }
          }
          const media = document.querySelector("video, audio") as HTMLMediaElement | null
          if (!media) throw new Error("No video or audio element found on page")
          if (command === "play") {
            void media.play()
            return { command: "play", paused: false }
          }
          if (command === "pause") {
            media.pause()
            return { command: "pause", paused: true }
          }
          if (command === "mute") {
            media.muted = true
            return { command: "mute", muted: true }
          }
          if (command === "unmute") {
            media.muted = false
            return { command: "unmute", muted: false }
          }
          if (media.paused) {
            void media.play()
            return { command: "play", paused: false }
          }
          media.pause()
          return { command: "pause", paused: true }
        },
      })
      return results?.[0]?.result
    }

    default:
      throw new Error(`Unsupported RPC action: ${action}`)
  }
}

export function formatActionSummary(action: string, params: Record<string, unknown> = {}): string {
  switch (action) {
    case "tabs":
      return "Inspected open tabs"
    case "read":
      return `Read page content (tab ${String(params.tabId ?? "active")})`
    case "eval":
      return "Evaluated custom script"
    case "click":
      return `Clicked element: ${String(params.selector ?? "")}`
    case "type":
      return `Typed into: ${String(params.selector ?? "")}`
    case "navigate":
      return `Navigated to ${String(params.url ?? "")}`
    case "activate":
      return `Switched to tab ${String(params.tabId ?? "")}`
    case "close":
      return `Closed tab ${String(params.tabId ?? "")}`
    case "media":
      return `Media control: ${String(params.action ?? params.command ?? "toggle")}`
    default:
      return `Executed action: ${action}`
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ZenRpcClientOptions {
  readonly url?: string
  readonly port?: number
  readonly httpFallbackUrl?: string
  readonly browserApi?: BrowserLike
  readonly wsFactory?: (url: string) => WebSocket
  readonly customFetch?: FetchLike
}

const defaultWsFactory = (u: string): WebSocket => {
  const Ctor =
    typeof WebSocket !== "undefined"
      ? WebSocket
      : typeof globalThis !== "undefined" && "WebSocket" in globalThis
        ? (globalThis as any).WebSocket
        : undefined
  if (!Ctor) {
    throw new Error("WebSocket constructor is not available in current environment")
  }
  return new Ctor(u)
}

export class ZenRpcClient {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private isDestroyed = false
  public isConnected = false
  public isWsConnected = false

  private readonly url: string
  private readonly browserApi: BrowserLike
  private readonly httpFallbackUrl: string
  private readonly wsFactory: (url: string) => WebSocket
  private readonly customFetch: FetchLike

  constructor(
    urlOrOptions: string | ZenRpcClientOptions = DEFAULT_RPC_URL,
    browserApiOrHttpFallback?: BrowserLike | string,
    fallbackUrlOrBrowserApi?: string | BrowserLike,
    wsFactory: (url: string) => WebSocket = defaultWsFactory,
    customFetch: FetchLike = (url, init) => fetch(url, init),
  ) {
    if (typeof urlOrOptions === "object" && urlOrOptions !== null) {
      const port = urlOrOptions.port ?? 4097
      this.url = urlOrOptions.url ?? (urlOrOptions.port ? `ws://127.0.0.1:${port}` : DEFAULT_RPC_URL)
      this.httpFallbackUrl =
        urlOrOptions.httpFallbackUrl ?? (urlOrOptions.port ? `http://127.0.0.1:${port}` : DEFAULT_HTTP_FALLBACK_URL)
      this.browserApi = urlOrOptions.browserApi ?? getBrowserApi() ?? {}
      this.wsFactory = urlOrOptions.wsFactory ?? wsFactory
      this.customFetch = urlOrOptions.customFetch ?? customFetch
    } else {
      this.url = typeof urlOrOptions === "string" ? urlOrOptions : DEFAULT_RPC_URL
      this.wsFactory = wsFactory
      this.customFetch = customFetch
      if (typeof browserApiOrHttpFallback === "string") {
        this.httpFallbackUrl = browserApiOrHttpFallback
        this.browserApi = (
          typeof fallbackUrlOrBrowserApi === "object" && fallbackUrlOrBrowserApi !== null
            ? fallbackUrlOrBrowserApi
            : (getBrowserApi() ?? {})
        ) as BrowserLike
      } else {
        this.browserApi = (browserApiOrHttpFallback ?? getBrowserApi() ?? {}) as BrowserLike
        this.httpFallbackUrl =
          typeof fallbackUrlOrBrowserApi === "string" ? fallbackUrlOrBrowserApi : DEFAULT_HTTP_FALLBACK_URL
      }
    }
  }

  public start() {
    this.isDestroyed = false
    console.log(`[ZenRpcClient] Starting RPC client (url=${this.url}, fallback=${this.httpFallbackUrl})`)
    // Send immediate HTTP heartbeat to establish connection status instantly
    void this.sendHeartbeat()
    try {
      this.connectWs()
    } catch (err) {
      console.error("[ZenRpcClient] Error starting WebSocket connection:", err)
      void this.sendHeartbeat()
    }
    try {
      this.startHttpFallback()
    } catch (err) {
      console.error("[ZenRpcClient] Error starting HTTP fallback:", err)
    }
  }

  public ensureConnected() {
    if (this.isDestroyed) return
    if (!this.isWsConnected && !this.ws) {
      console.log("[ZenRpcClient] ensureConnected triggered: reconnecting WebSocket...")
      this.connectWs()
    }
    void this.sendHeartbeat()
  }

  public stop() {
    this.isDestroyed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.isWsConnected = false
    this.setConnectionState(false)
  }

  private setConnectionState(connected: boolean) {
    if (this.isConnected !== connected) {
      this.isConnected = connected
      console.log(`[ZenRpcClient] Connection state changed: ${connected ? "CONNECTED" : "DISCONNECTED"}`)
      this.broadcastStatus(connected)
    }
  }

  private connectWs() {
    if (this.isDestroyed) return

    try {
      console.log(`[ZenRpcClient] Creating WebSocket instance to ${this.url}`)
      this.ws = this.wsFactory(this.url)

      this.ws.onopen = () => {
        console.log(`[ZenRpcClient] WebSocket connection established to ${this.url}`)
        this.isWsConnected = true
        this.setConnectionState(true)
        this.send({
          type: "hello",
          client: "zen-extension",
          version: "1.0.0",
        })
      }

      this.ws.onmessage = (event) => {
        void this.handleMessage(event.data)
      }

      this.ws.onclose = () => {
        console.warn(`[ZenRpcClient] WebSocket closed for ${this.url}`)
        this.handleWsDisconnect()
      }

      this.ws.onerror = (err) => {
        console.error(`[ZenRpcClient] WebSocket error for ${this.url}:`, err)
        this.handleWsDisconnect()
        void this.sendHeartbeat()
      }
    } catch (err) {
      console.error(`[ZenRpcClient] Failed to instantiate WebSocket for ${this.url}:`, err)
      this.handleWsDisconnect()
      void this.sendHeartbeat()
    }
  }

  private handleWsDisconnect() {
    this.isWsConnected = false
    if (!this.isConnected) {
      this.setConnectionState(false)
    }
    if (this.isDestroyed) return
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.connectWs()
      }, RECONNECT_INTERVAL_MS)
    }
  }

  private startHttpFallback() {
    if (this.isDestroyed) return

    // Regular heartbeat
    this.heartbeatTimer = setInterval(() => {
      if (this.isDestroyed) return
      void this.sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)

    // Initial heartbeat immediately
    void this.sendHeartbeat()

    // Start poll loop
    this.scheduleNextPoll(100)
  }

  private scheduleNextPoll(delayMs = HTTP_POLL_INTERVAL_MS) {
    if (this.isDestroyed) return
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.executeHttpPoll()
    }, delayMs)
  }

  private async sendHeartbeat(): Promise<void> {
    const candidateUrls = [this.httpFallbackUrl]
    if (this.httpFallbackUrl.includes("127.0.0.1")) {
      candidateUrls.push(this.httpFallbackUrl.replace("127.0.0.1", "localhost"))
    }

    for (const baseUrl of candidateUrls) {
      try {
        const res = await this.customFetch(`${baseUrl}/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client: "zen-extension", version: "1.0.0" }),
        })
        if (res.ok) {
          this.setConnectionState(true)
          return
        }
      } catch {
        // try next candidate url
      }
    }

    if (!this.isWsConnected) {
      this.setConnectionState(false)
    }
  }

  private async executeHttpPoll(): Promise<void> {
    if (this.isDestroyed) return

    // If WebSocket is actively connected, we still check server heartbeat occasionally, but skip heavy poll
    if (this.isWsConnected) {
      this.scheduleNextPoll(HTTP_POLL_INTERVAL_MS)
      return
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      const res = await this.customFetch(`${this.httpFallbackUrl}/poll`, {
        method: "GET",
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))

      if (res.ok) {
        this.setConnectionState(true)
        if (res.status === 200) {
          const data = (await res.json()) as RpcRequest | { empty?: boolean } | null
          if (data && typeof data === "object" && "id" in data && "action" in data) {
            void this.executeHttpRpcRequest(data as RpcRequest)
          }
        }
      } else {
        if (!this.isWsConnected) {
          this.setConnectionState(false)
        }
      }
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError"
      if (!isAbort && !this.isWsConnected) {
        this.setConnectionState(false)
      }
    } finally {
      this.scheduleNextPoll(HTTP_POLL_INTERVAL_MS)
    }
  }

  private async executeHttpRpcRequest(req: RpcRequest): Promise<void> {
    const { id, action, params = {} } = req
    try {
      const result = await handleRpcAction(action, params, this.browserApi)
      await this.customFetch(`${this.httpFallbackUrl}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, success: true, result }),
      })
      this.broadcastActivity({
        action,
        summary: formatActionSummary(action, params),
        success: true,
        timestamp: Date.now(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.customFetch(`${this.httpFallbackUrl}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, success: false, error: message }),
      })
      this.broadcastActivity({
        action,
        summary: `Failed ${action}: ${message}`,
        success: false,
        timestamp: Date.now(),
      })
    }
  }

  private broadcastStatus(connected: boolean) {
    try {
      this.browserApi.runtime?.sendMessage?.({
        type: "RPC_STATUS",
        connected,
      })
    } catch {
      // Ignore when no listener is active
    }
  }

  private broadcastActivity(event: AiActivityEvent) {
    try {
      this.browserApi.runtime?.sendMessage?.({
        type: "AI_ACTIVITY",
        activity: event,
      })
    } catch {
      // Ignore when no listener is active
    }
  }

  private send(data: unknown) {
    if (this.ws && (this.ws.readyState === 1 || (typeof WebSocket !== "undefined" && this.ws.readyState === WebSocket.OPEN))) {
      this.ws.send(JSON.stringify(data))
    }
  }

  public async handleMessage(raw: unknown) {
    let req: RpcRequest
    try {
      req = (typeof raw === "string" ? JSON.parse(raw) : raw) as RpcRequest
    } catch {
      return
    }

    if (!req || typeof req !== "object" || !("id" in req) || !("action" in req)) {
      return
    }

    const { id, action, params = {} } = req
    try {
      const result = await handleRpcAction(action, params, this.browserApi)
      this.send({ id, success: true, result })
      this.broadcastActivity({
        action,
        summary: formatActionSummary(action, params),
        success: true,
        timestamp: Date.now(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.send({ id, success: false, error: message })
      this.broadcastActivity({
        action,
        summary: `Failed ${action}: ${message}`,
        success: false,
        timestamp: Date.now(),
      })
    }
  }
}
