/**
 * Two-way RPC bridge client for Zen Browser extension
 * Connects via WebSocket to Orchestra daemon (ws://127.0.0.1:4097)
 * Allows autonomous AI control: inspecting tabs, reading DOM, executing scripts, controlling media.
 */

export const DEFAULT_RPC_URL = "ws://127.0.0.1:4097"
export const RECONNECT_INTERVAL_MS = 2000

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
    query: (queryInfo: Record<string, unknown>) => Promise<Array<{
      id?: number
      title?: string
      url?: string
      active?: boolean
      audible?: boolean
      mutedInfo?: { muted?: boolean }
      muted?: boolean
    }>>
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
          const el = document.querySelector(targetSelector) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
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
      const cmd = typeof params.action === "string" ? params.action : typeof params.command === "string" ? params.command : "toggle"
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
            const nextBtn = document.querySelector(".ytp-next-button, button[aria-label='Next'], [data-testid='control-button-skip-forward']") as HTMLElement | null
            if (nextBtn) {
              nextBtn.click()
              return { command: "next", handledByButton: true }
            }
          }
          if (command === "prev") {
            const prevBtn = document.querySelector(".ytp-prev-button, button[aria-label='Previous'], [data-testid='control-button-skip-back']") as HTMLElement | null
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

export class ZenRpcClient {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private isDestroyed = false
  public isConnected = false

  constructor(
    private readonly url = DEFAULT_RPC_URL,
    private readonly browserApi = getBrowserApi() ?? {},
    private readonly wsFactory: (url: string) => WebSocket = (u) => new WebSocket(u),
  ) {}

  public start() {
    this.isDestroyed = false
    this.connect()
  }

  public stop() {
    this.isDestroyed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.isConnected = false
    this.broadcastStatus(false)
  }

  private connect() {
    if (this.isDestroyed) return

    try {
      this.ws = this.wsFactory(this.url)

      this.ws.onopen = () => {
        this.isConnected = true
        this.broadcastStatus(true)
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
        this.handleDisconnect()
      }

      this.ws.onerror = () => {
        this.handleDisconnect()
      }
    } catch {
      this.handleDisconnect()
    }
  }

  private handleDisconnect() {
    this.isConnected = false
    this.broadcastStatus(false)
    if (this.isDestroyed) return
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.connect()
      }, RECONNECT_INTERVAL_MS)
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
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
