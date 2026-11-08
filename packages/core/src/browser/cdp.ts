export * as Cdp from "./cdp.js"

// A small Chrome DevTools Protocol client: one websocket to one page, request ids matched to replies.

export interface Socket {
  send(data: string): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onopen: (() => void) | null
}

export interface Client {
  readonly send: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  readonly close: () => void
  /** Listens to a protocol event such as Page.screencastFrame; returns the way to stop listening. */
  readonly on: (method: string, listener: (params: any) => void) => () => void
}

export function connect(
  open: (url: string) => Socket,
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<Client> {
  const timeoutMs = options.timeoutMs ?? 10_000
  return new Promise((resolve, reject) => {
    const socket = open(url)
    let next = 0
    let closed = false
    const listeners = new Map<string, Set<(params: any) => void>>()
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
    >()
    const failAll = (message: string) => {
      closed = true
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(message))
        pending.delete(id)
      }
    }
    socket.onerror = () => {
      failAll("The browser connection failed.")
      reject(new Error("Could not connect to Chrome."))
    }
    socket.onclose = () => failAll("The browser connection closed.")
    socket.onmessage = (event) => {
      let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id === undefined) {
        if (message.method) for (const listener of listeners.get(message.method) ?? []) listener(message.params)
        return
      }
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(message.error.message ?? "Browser command failed."))
      else entry.resolve(message.result)
    }
    socket.onopen = () =>
      resolve({
        send: <T>(method: string, params: Record<string, unknown> = {}) =>
          new Promise<T>((done, fail) => {
            if (closed) return fail(new Error("The browser connection closed."))
            const id = ++next
            const timer = setTimeout(() => {
              pending.delete(id)
              fail(new Error(`${method} timed out.`))
            }, timeoutMs)
            pending.set(id, { resolve: done, reject: fail, timer })
            socket.send(JSON.stringify({ id, method, params }))
          }),
        on: (method, listener) => {
          const set = listeners.get(method) ?? new Set()
          set.add(listener)
          listeners.set(method, set)
          return () => void set.delete(listener)
        },
        close: () => {
          failAll("The browser connection closed.")
          socket.close()
        },
      })
  })
}

/** The first normal page target's websocket address from /json/list. */
export function pageSocketUrl(targets: ReadonlyArray<{ type?: string; webSocketDebuggerUrl?: string }>) {
  return targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl)?.webSocketDebuggerUrl
}

export const navigate = (client: Client, url: string) => client.send("Page.navigate", { url })

/** The visible text of the page, for the text view. */
export async function pageText(client: Client, limit = 20_000) {
  const result = await client.send<{ result?: { value?: string } }>("Runtime.evaluate", {
    expression: "document.body ? document.body.innerText : ''",
    returnByValue: true,
  })
  const text = result.result?.value ?? ""
  return text.length > limit ? text.slice(0, limit) : text
}

export async function pageInfo(client: Client) {
  const result = await client.send<{ result?: { value?: { url?: string; title?: string } } }>("Runtime.evaluate", {
    expression: "({ url: location.href, title: document.title })",
    returnByValue: true,
  })
  return { url: result.result?.value?.url ?? "", title: result.result?.value?.title ?? "" }
}

/** A PNG of the page as base64. */
export async function screenshot(client: Client) {
  const result = await client.send<{ data: string }>("Page.captureScreenshot", { format: "png" })
  return result.data
}

/** Makes the page lay out for a pane of this size in pixels (no scale, so frames match the pane). */
export const setViewport = (client: Client, width: number, height: number) =>
  client.send("Emulation.setDeviceMetricsOverride", {
    width: Math.max(200, Math.round(width)),
    height: Math.max(120, Math.round(height)),
    deviceScaleFactor: 1,
    mobile: false,
  })

export interface Frame {
  /** JPEG bytes as base64. */
  readonly data: string
  readonly width: number
  readonly height: number
}

/**
 * Streams the page as JPEG frames. Chrome sends a frame only when the page changes and waits for each one
 * to be acknowledged, so a slow terminal naturally lowers the rate. Returns a function that stops it.
 */
export async function startScreencast(
  client: Client,
  options: { width: number; height: number; quality?: number; everyNthFrame?: number },
  onFrame: (frame: Frame) => void,
) {
  const off = client.on(
    "Page.screencastFrame",
    (params: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
      void client.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined)
      onFrame({
        data: params.data,
        width: params.metadata?.deviceWidth ?? options.width,
        height: params.metadata?.deviceHeight ?? options.height,
      })
    },
  )
  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality: options.quality ?? 60,
    maxWidth: Math.round(options.width),
    maxHeight: Math.round(options.height),
    everyNthFrame: options.everyNthFrame ?? 1,
  })
  return () => {
    off()
    void client.send("Page.stopScreencast").catch(() => undefined)
  }
}
