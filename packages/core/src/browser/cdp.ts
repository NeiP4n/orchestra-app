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
  /** True once the websocket closed or failed: nothing can be sent on this client any more. */
  readonly isClosed?: () => boolean
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
    let opened = false
    const openingTimer = setTimeout(() => {
      if (opened) return
      closed = true
      socket.close()
      reject(new Error("Chrome websocket did not open in time."))
    }, timeoutMs)
    const listeners = new Map<string, Set<(params: any) => void>>()
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
    >()
    const failAll = (message: string) => {
      clearTimeout(openingTimer)
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
    socket.onclose = () => { failAll("The browser connection closed."); if (!opened) reject(new Error("Chrome websocket closed before opening.")) }
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
    socket.onopen = () => {
      if (closed) return
      opened = true
      clearTimeout(openingTimer)
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
        isClosed: () => closed,
        close: () => {
          failAll("The browser connection closed.")
          socket.close()
        },
      })
    }
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
 * Streams the page as JPEG frames. Frames are coalesced to at most four deliveries per second, with deferred acknowledgements
 * as backpressure. Encoding dimensions are bounded too. Returns a function that stops it.
 */
export async function startScreencast(
  client: Client,
  options: { width: number; height: number; quality?: number; everyNthFrame?: number },
  onFrame: (frame: Frame) => void,
) {
  let lastAt = -Infinity
  let stopped = false
  let delivered = false
  let initial: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let latest: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } } | undefined
  const acknowledgements = new Set<number>()
  const flush = () => {
    timer = undefined
    const frame = latest
    latest = undefined
    for (const sessionId of acknowledgements) void client.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined)
    acknowledgements.clear()
    if (!frame) return
    lastAt = Date.now()
    delivered = true
    onFrame({ data: frame.data, width: frame.metadata?.deviceWidth ?? options.width, height: frame.metadata?.deviceHeight ?? options.height })
  }
  const off = client.on("Page.screencastFrame", (params) => {
    latest = params
    acknowledgements.add(params.sessionId)
    if (acknowledgements.size > 32) { // Defensive bound, even for a broken endpoint.
      const oldest = acknowledgements.values().next().value!
      acknowledgements.delete(oldest)
      void client.send("Page.screencastFrameAck", { sessionId: oldest }).catch(() => undefined)
    }
    if (Date.now() - lastAt >= 250) { clearTimeout(timer); flush() }
    else if (timer === undefined) timer = setTimeout(flush, 250 - (Date.now() - lastAt))
  })
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    clearTimeout(initial)
    latest = undefined
    acknowledgements.clear()
    off()
    void client.send("Page.stopScreencast").catch(() => undefined)
  }
  try {
    await client.send("Page.enable")
    await client.send("Page.startScreencast", {
      format: "jpeg",
      quality: options.quality ?? 50,
      maxWidth: Math.min(1280, Math.round(options.width)),
      maxHeight: Math.min(800, Math.round(options.height)),
      everyNthFrame: options.everyNthFrame ?? 4,
    })
    // Some idle/background pages send no initial screencast event. One read-only
    // screenshot seeds the view; this is not a polling loop or a higher FPS cap.
    initial = setTimeout(() => {
      if (stopped || delivered) return
      void screenshot(client).then((data) => {
        if (stopped || delivered) return
        delivered = true
        onFrame({ data, width: options.width, height: options.height })
      }).catch(() => undefined)
    }, 2000)
    return stop
  } catch (error) { stop(); throw error }
}

export type MouseInput =
  | { kind: "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right" }
  | { kind: "move"; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; deltaY: number; deltaX?: number }

/** Forwards a mouse action to the page, like a person using it. Coordinates are in page pixels. */
export function mouse(client: Client, input: MouseInput) {
  const base = { x: Math.round(input.x), y: Math.round(input.y) }
  if (input.kind === "move") return client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base })
  if (input.kind === "wheel")
    return client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...base,
      deltaX: input.deltaX ?? 0,
      deltaY: input.deltaY,
    })
  const button = input.button ?? "left"
  const pressed = input.kind === "down"
  const press = () =>
    client.send("Input.dispatchMouseEvent", {
      type: pressed ? "mousePressed" : "mouseReleased",
      ...base,
      button,
      // The buttons bitmask is what pages read for pointer events; a press without it can be ignored.
      buttons: pressed ? (button === "right" ? 2 : button === "middle" ? 4 : 1) : 0,
      clickCount: 1,
    })
  // A person's pointer is on the spot before it clicks: pages (consent dialogs, hover menus) expect that move.
  if (!pressed) return press()
  return client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base }).then(press)
}

// Keys that are not text. [key, code, Windows virtual key code]
const SPECIAL: Record<string, readonly [string, string, number]> = {
  return: ["Enter", "Enter", 13],
  enter: ["Enter", "Enter", 13],
  backspace: ["Backspace", "Backspace", 8],
  tab: ["Tab", "Tab", 9],
  escape: ["Escape", "Escape", 27],
  delete: ["Delete", "Delete", 46],
  up: ["ArrowUp", "ArrowUp", 38],
  down: ["ArrowDown", "ArrowDown", 40],
  left: ["ArrowLeft", "ArrowLeft", 37],
  right: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
}

const EDIT_KEYS: Record<string, string[]> = {
  Backspace: ["deleteBackward"],
  Delete: ["deleteForward"],
}

const EDITING: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  x: "cut",
  v: "paste",
  z: "undo",
  y: "redo",
}

export type KeyStep =
  | { method: "Input.insertText"; params: { text: string } }
  | { method: "Input.dispatchKeyEvent"; params: Record<string, unknown> }

/**
 * The protocol calls for one key press. Printable text is inserted as text (so any language types), named
 * keys go as real key events. Combinations with ctrl or alt are not forwarded: they are the terminal's.
 */
export function keySteps(key: {
  name: string
  sequence: string
  ctrl?: boolean
  meta?: boolean
  option?: boolean
}): KeyStep[] {
  if (key.ctrl && !key.meta && !key.option && /^[a-z]$/.test(key.name)) {
    // Editing shortcuts act through Chrome's own editor commands, so select all, copy, cut, paste and undo work.
    const command = EDITING[key.name]
    if (!command) return []
    const upper = key.name.toUpperCase()
    const common = {
      key: key.name,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      nativeVirtualKeyCode: upper.charCodeAt(0),
      modifiers: 2,
    }
    return [
      { method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", ...common, commands: [command] } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...common } },
    ]
  }
  if (key.ctrl || key.meta || key.option) return []
  const special = SPECIAL[key.name]
  if (special) {
    const [name, code, vk] = special
    const text = name === "Enter" ? "\r" : undefined
    const common = { key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    // Chrome's own editing commands make deleting work in every kind of field.
    const commands = EDIT_KEYS[name]
    return [
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: text ? "keyDown" : "rawKeyDown",
          ...common,
          ...(text ? { text, unmodifiedText: text } : {}),
          ...(commands ? { commands } : {}),
        },
      },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...common } },
    ]
  }
  if (key.name === "space" || key.sequence === " ") return [{ method: "Input.insertText", params: { text: " " } }]
  if (key.sequence.length > 0 && !/^[\x00-\x1f\x7f]/.test(key.sequence) && !key.sequence.startsWith("\x1b"))
    return [{ method: "Input.insertText", params: { text: key.sequence } }]
  return []
}

/**
 * Enter, Backspace and Delete done inside the page, for a Chrome window that drops routed key events (typed text
 * still arrives because inserting text does not go through the input router). The page sees the usual key events
 * (so its own handlers, like a search box's Enter, run); when it does not cancel them the editing itself follows.
 */
export function editKeyScript(name: string) {
  const spec =
    name === "return" || name === "enter"
      ? ["Enter", 13]
      : name === "backspace"
        ? ["Backspace", 8]
        : name === "delete"
          ? ["Delete", 46]
          : undefined
  if (!spec) return undefined
  return `(() => {
  let e = document.activeElement || document.body
  while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement
  const o = { key: ${JSON.stringify(spec[0])}, code: ${JSON.stringify(spec[0])}, keyCode: ${spec[1]}, which: ${spec[1]}, bubbles: true, cancelable: true, composed: true }
  const down = e.dispatchEvent(new KeyboardEvent('keydown', o))
  const press = ${spec[1] === 13 ? "down && e.dispatchEvent(new KeyboardEvent('keypress', o))" : "false"}
  e.dispatchEvent(new KeyboardEvent('keyup', o))
  if (down) {
    if (${spec[1]} === 8) document.execCommand('delete')
    else if (${spec[1]} === 46) document.execCommand('forwardDelete')
    else if (press) {
      if (e.isContentEditable || e.tagName === 'TEXTAREA') document.execCommand('insertLineBreak')
      else if (e.form && e.tagName === 'INPUT') { if (e.form.requestSubmit) e.form.requestSubmit(); else e.form.submit() }
      else if (e.tagName === 'BUTTON' || e.tagName === 'A' || e.tagName === 'SUMMARY') e.click()
    }
  }
  return e.tagName + (e.id ? '#' + e.id : '') + (down ? '' : ' (page handled it)')
})()`
}

export async function key(client: Client, input: Parameters<typeof keySteps>[0]) {
  for (const step of keySteps(input)) await client.send(step.method, step.params)
}

/** Data arguments stay separate from the fixed page function source. */
export interface PageCall {
  functionDeclaration: string
  arguments: Array<{ value: unknown }>
}

export async function callPage<T>(client: Client, call: PageCall, awaitPromise = false) {
  const target = await client.send<{ result?: { objectId?: string }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: "globalThis", returnByValue: false })
  const objectId = target.result?.objectId
  if (!objectId || target.exceptionDetails) throw new Error("The page execution context is unavailable.")
  try {
    return await client.send<T>("Runtime.callFunctionOn", { ...call, objectId, returnByValue: true, awaitPromise })
  } finally {
    await client.send("Runtime.releaseObject", { objectId }).catch(() => undefined)
  }
}
