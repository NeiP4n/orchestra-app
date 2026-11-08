export * as BrowserRuntime from "./runtime.js"

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Global } from "@orchestra/util/global"
import { BrowserBridge } from "./bridge.js"
import { Cdp } from "./cdp.js"
import { BrowserTabs } from "./tabs.js"
import { Chrome } from "./chrome.js"
import { WindowCapture } from "./window-capture.js"

// One Chrome per browser session, shared by the Browser tab and the chat agent. A Chrome that already runs
// on the session's profile is joined, never started twice. Chrome starts only when somebody asks, and the
// ones this process started close with it. The operator's own Chrome profile is never used.

interface Live {
  port: number
  tabID: string
  /** A visible Chrome window the operator uses directly; it outlives this app and is never killed on exit. */
  windowed: boolean
  /** Set when the pane shows a real, off-screen Chrome window copied by the Windows helper. */
  capture?: WindowCapture.Controller
  client: Cdp.Client
  /** Closes the process only when this process started it. */
  stop: () => void
}

/** A new session opens here instead of a blank page, so the stream visibly shows something. */
export const START_PAGE = "https://www.google.com/"

const live = new Map<string, Live>()
const starting = new Map<string, Promise<Live>>()
let hooked = false

const deps: Chrome.Deps = {
  spawn: (exe, args) => spawn(exe, args, { stdio: "ignore", windowsHide: true }),
  readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
  remove: (file) => rmSync(file, { force: true }),
}

const alive = async (port: number) => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok

const connectTab = (tab: BrowserTabs.Tab) =>
  Cdp.connect((address) => new WebSocket(address) as unknown as Cdp.Socket, tab.wsUrl)

/** Joins the first tab of a running Chrome, or opens one when it has none. */
async function join(port: number, stop: () => void, windowed = false): Promise<Live> {
  const tab = (await BrowserTabs.list(port))[0] ?? (await BrowserTabs.create(port))
  return { port, tabID: tab.id, windowed, client: await connectTab(tab), stop }
}

// A visible window must not be hidden, unlike the windowless session Chrome.
const windowDeps: Chrome.Deps = {
  ...deps,
  spawn: (exe, args) => spawn(exe, args, { stdio: "ignore", windowsHide: false }),
}

/** Asks Chrome itself to quit (works for a Chrome this process did not start) and waits until its port is gone. */
async function quit(port: number) {
  try {
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl?: string
    }
    if (version.webSocketDebuggerUrl) {
      const browser = await Cdp.connect(
        (address) => new WebSocket(address) as unknown as Cdp.Socket,
        version.webSocketDebuggerUrl,
      )
      await browser.send("Browser.close").catch(() => undefined)
      browser.close()
    }
  } catch {
    // Already gone.
  }
  for (let i = 0; i < 60; i++) {
    if (!(await alive(port).catch(() => false))) return
    await deps.sleep(150)
  }
  throw new Error("Chrome did not close in time.")
}

/** Before Chrome starts on a profile: record the last exit as clean (see Chrome.cleanExitPreferences). */
function calm(dir: string) {
  const file = path.join(dir, "Default", "Preferences")
  try {
    const next = Chrome.cleanExitPreferences(readFileSync(file, "utf8"))
    if (next !== undefined) writeFileSync(file, next)
  } catch {
    // No profile yet, or unreadable: Chrome makes its own.
  }
}

/** Lets a window that Chrome treats as unfocused or hidden still take clicks and keys from DevTools. */
async function awake(client: Cdp.Client) {
  await within(client.send("Emulation.setFocusEmulationEnabled", { enabled: true }), 800).catch(() => undefined)
  await within(client.send("Page.bringToFront"), 800).catch(() => undefined)
}

/** A DevTools call that never answers must not freeze the operator's input: give up after `ms`. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer from Chrome in ${ms} ms`)), ms)
    work.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error)),
    )
  })
}

async function start(sessionID: string): Promise<Live> {
  const dir = Chrome.profileDir(Global.Path.data, sessionID)
  const port = await Chrome.livePort(deps.readFile, alive, dir)
  if (port !== undefined) return join(port, () => {})
  const exe = Chrome.find(existsSync)
  if (!exe) throw new Error("Google Chrome or Microsoft Edge was not found. Install one, or set ORCHESTRA_CHROME_PATH.")
  calm(dir)
  const run = await Chrome.launch(deps, { exe, profileDir: dir, headless: true, url: START_PAGE })
  try {
    return await join(run.port, run.close)
  } catch (error) {
    run.close()
    throw error
  }
}

/** The running browser of a session, started (or joined) on first use. */
export async function open(sessionID: string): Promise<Cdp.Client> {
  // A restart in progress owns the session: starting another Chrome beside it is what left input hanging.
  const restarting = relaunching.get(sessionID)
  if (restarting && !inside.has(sessionID)) await restarting.catch(() => undefined)
  const existing = live.get(sessionID)
  if (existing) return existing.client
  const pending = starting.get(sessionID)
  if (pending) return (await pending).client
  if (!hooked) {
    hooked = true
    process.on("exit", closeAll)
  }
  const promise = start(sessionID)
    .then((value) => {
      live.set(sessionID, value)
      return value
    })
    .finally(() => starting.delete(sessionID))
  starting.set(sessionID, promise)
  return (await promise).client
}

export const isOpen = (sessionID: string) => live.has(sessionID)

export async function go(sessionID: string, address: string) {
  await Cdp.navigate(await open(sessionID), Chrome.omnibox(address))
}

export async function read(sessionID: string) {
  const client = await open(sessionID)
  const [info, text] = await Promise.all([Cdp.pageInfo(client), Cdp.pageText(client)])
  return { ...info, text }
}

const screens = new Map<string, () => void>()
const watchers = new Map<string, { size: { width: number; height: number }; onFrame: (frame: Cdp.Frame) => void }>()

/**
 * Streams the session's page as frames sized for a pane of `width` x `height` pixels. The page is laid out
 * at exactly that size, so call it again with the new size when the pane changes. One stream per session.
 */
export async function watch(
  sessionID: string,
  size: { width: number; height: number },
  onFrame: (frame: Cdp.Frame) => void,
) {
  const client = await open(sessionID)
  unwatch(sessionID)
  const capture = live.get(sessionID)?.capture
  if (capture) return capture.watch(size, onFrame)
  watchers.set(sessionID, { size, onFrame })
  await stream(sessionID, client)
}

async function stream(sessionID: string, client: Cdp.Client) {
  const watcher = watchers.get(sessionID)
  if (!watcher) return
  await Cdp.setViewport(client, watcher.size.width, watcher.size.height)
  screens.set(sessionID, await Cdp.startScreencast(client, watcher.size, watcher.onFrame))
}

export function unwatch(sessionID: string) {
  live.get(sessionID)?.capture?.unwatch()
  screens.get(sessionID)?.()
  screens.delete(sessionID)
  watchers.delete(sessionID)
}

export interface TabState {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly active: boolean
}

// Chrome lists the newest tab first; a tab strip keeps tabs where they were opened, so order is remembered.
const orders = new Map<string, string[]>()
function ordered(sessionID: string, list: BrowserTabs.Tab[]) {
  const seen = (orders.get(sessionID) ?? []).filter((id) => list.some((tab) => tab.id === id))
  const fresh = list.filter((tab) => !seen.includes(tab.id)).reverse()
  const order = [...seen, ...fresh.map((tab) => tab.id)]
  orders.set(sessionID, order)
  return order.map((id) => list.find((tab) => tab.id === id)!)
}

/** The session's tabs as Chrome lists them now. The active one is repaired if its tab was closed by the page. */
export async function tabs(sessionID: string): Promise<TabState[]> {
  await open(sessionID)
  const item = live.get(sessionID)!
  let list = ordered(sessionID, await BrowserTabs.list(item.port))
  if (list.length === 0) list = [await BrowserTabs.create(item.port)]
  if (!list.some((tab) => tab.id === item.tabID)) await switchTo(sessionID, list[0]!)
  return list.map((tab) => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.id === live.get(sessionID)!.tabID,
  }))
}

/** Moves the session onto another tab: its frames, the agent tool and the address bar follow it. */
async function switchTo(sessionID: string, tab: BrowserTabs.Tab) {
  const item = live.get(sessionID)
  if (!item || item.tabID === tab.id) return
  const previous = item.client
  screens.get(sessionID)?.()
  screens.delete(sessionID)
  item.client = await connectTab(tab)
  item.tabID = tab.id
  previous.close()
  await BrowserTabs.activate(item.port, tab.id).catch(() => undefined)
  await stream(sessionID, item.client)
}

export async function selectTab(sessionID: string, tabID: string) {
  await open(sessionID)
  const tab = (await BrowserTabs.list(live.get(sessionID)!.port)).find((entry) => entry.id === tabID)
  if (!tab) throw new Error("That tab is already closed.")
  await switchTo(sessionID, tab)
}

/** Opens a new tab and switches to it. */
export async function newTab(sessionID: string, address?: string) {
  await open(sessionID)
  const item = live.get(sessionID)!
  const tab = await BrowserTabs.create(item.port, address ? Chrome.normalizeUrl(address) : undefined)
  await switchTo(sessionID, tab)
}

/** Closes a tab; closing the last one leaves a blank tab, like Chrome keeps a window open. */
export async function closeTab(sessionID: string, tabID: string) {
  await open(sessionID)
  const item = live.get(sessionID)!
  const before = ordered(sessionID, await BrowserTabs.list(item.port))
  const next = BrowserTabs.neighbour(before, tabID) ?? (await BrowserTabs.create(item.port))
  if (item.tabID === tabID) await switchTo(sessionID, next)
  await BrowserTabs.close(item.port, tabID)
}

/** Back (-1) or forward (+1) in the active tab's history. */
export async function history(sessionID: string, step: -1 | 1) {
  const client = await open(sessionID)
  const state = await client.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory")
  const entry = state.entries[state.currentIndex + step]
  if (!entry) return false
  await client.send("Page.navigateToHistoryEntry", { entryId: entry.id })
  return true
}

/** Mouse and keys from the operator, forwarded into the active tab. */
// Real Chrome in the pane: the picture is the whole window, so a point is either on Chrome's own UI (tab strip,
// address bar), which only takes window messages, or on the page, which takes reliable DevTools input.
interface Inset {
  readonly left: number
  readonly top: number
  readonly scale: number
  readonly at: number
  /** What Chrome reported: outer and inner size in CSS pixels, for the debug line. */
  readonly raw: string
}
const insets = new Map<string, Inset>()
// Where the last press landed: keys go to the address bar (window messages) or to the page (DevTools).
const uiFocus = new Map<string, boolean>()

async function inset(sessionID: string, client: Cdp.Client): Promise<Inset> {
  const known = insets.get(sessionID)
  if (known && Date.now() - known.at < 1500) return known
  const result = (await within(
    client.send("Runtime.evaluate", {
      expression: "[outerWidth, outerHeight, innerWidth, innerHeight, devicePixelRatio]",
      returnByValue: true,
    }),
    1200,
  )) as { result?: { value?: number[] } }
  const [ow = 0, oh = 0, iw = 0, ih = 0, scale = 1] = result.result?.value ?? []
  const next = {
    left: Math.max(0, ((ow - iw) / 2) * scale),
    top: Math.max(0, (oh - ih) * scale),
    scale: scale || 1,
    at: Date.now(),
    raw: `outer ${ow}x${oh} inner ${iw}x${ih} dpr ${scale}`,
  }
  insets.set(sessionID, next)
  return next
}

/** Forwards the operator's mouse. Returns a short note on where it went, for the pane's debug line. */
export async function mouse(
  sessionID: string,
  input: Cdp.MouseInput,
  step: (text: string) => void = () => undefined,
): Promise<string> {
  step("runtime called")
  const client = await within(open(sessionID), 3000).catch((error: unknown) => {
    throw new Error(`browser not ready (${error instanceof Error ? error.message : String(error)})`)
  })
  step("browser open")
  const capture = live.get(sessionID)?.capture
  if (!capture) {
    if (input.kind === "down") await awake(client)
    await within(Cdp.mouse(client, input), 2000)
    return "page"
  }
  let why = ""
  const frame = await inset(sessionID, client).catch((error: unknown) => {
    why = error instanceof Error ? error.message : String(error)
    return undefined
  })
  step(frame ? "page offset read" : `no page offset (${why || "unknown"})`)
  if (frame && input.y >= frame.top && input.x >= frame.left) {
    if (input.kind === "down") {
      uiFocus.set(sessionID, false)
      await awake(client)
    }
    step("sending to the page")
    await within(
      Cdp.mouse(client, {
        ...input,
        x: (input.x - frame.left) / frame.scale,
        y: (input.y - frame.top) / frame.scale,
      }),
      2000,
    )
    return `PAGE at ${Math.round((input.x - frame.left) / frame.scale)},${Math.round((input.y - frame.top) / frame.scale)} from window ${Math.round(input.x)},${Math.round(input.y)} (${frame.raw}, top inset ${Math.round(frame.top)}px)`
  }
  if (input.kind === "down") uiFocus.set(sessionID, true)
  step("sending to the Chrome window")
  capture.mouse(input)
  return `CHROME-UI window ${Math.round(input.x)},${Math.round(input.y)}${frame ? ` (${frame.raw}, top inset ${Math.round(frame.top)}px)` : ` (no inset: ${why || "unknown"})`}`
}

export async function key(sessionID: string, input: Parameters<typeof Cdp.key>[1]) {
  const client = await open(sessionID)
  const capture = live.get(sessionID)?.capture
  if (capture && uiFocus.get(sessionID)) return capture.key(input)
  await Cdp.key(client, input)
}

export async function reload(sessionID: string) {
  await (await open(sessionID)).send("Page.reload")
}

export function close(sessionID: string) {
  unwatch(sessionID)
  orders.delete(sessionID)
  const item = live.get(sessionID)
  if (!item) return
  live.delete(sessionID)
  item.client.close()
  item.capture?.stop()
  // Ask Chrome to quit so it saves its session cleanly; only if that fails is the process stopped.
  void quit(item.port).catch(() => item.stop())
}

/** At exit only the windowless Chromes close; a window the operator is using stays open. */
export function closeAll() {
  // The process is ending, so nothing can be awaited here: stop them outright. The next start marks the profile's
  // last exit as clean, so Chrome does not ask to restore pages.
  for (const [id, item] of [...live]) {
    if (item.windowed) continue
    unwatch(id)
    live.delete(id)
    item.client.close()
    item.capture?.stop()
    item.stop()
  }
}

export const isWindowed = (sessionID: string) => live.get(sessionID)?.windowed === true

export type Mode = "headless" | "window" | "capture"

export const modeOf = (sessionID: string): Mode => {
  const item = live.get(sessionID)
  return item?.capture ? "capture" : item?.windowed ? "window" : "headless"
}

/** Where the helper script lives: written once, outside the repo, run with PowerShell. */
function helperFile() {
  const file = path.join(Global.Path.data, "browser-profiles", "window-capture.ps1")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, WindowCapture.SCRIPT)
  return file
}

/**
 * Restarts the session's Chrome on the same profile in another mode. "headless" is the windowless Chrome the
 * pane streams through the protocol, "window" is a normal visible Chrome window, "capture" (Windows only) is a
 * real Chrome window kept off-screen and out of the taskbar whose pixels the pane shows. The open tabs'
 * addresses are reopened; logins stay in the profile, unsaved page state does not survive.
 */
const relaunching = new Map<string, Promise<void>>()
const inside = new Set<string>()

export async function relaunch(sessionID: string, mode: Mode | boolean, size = { width: 1000, height: 640 }) {
  const before = relaunching.get(sessionID)
  if (before) await before.catch(() => undefined)
  const run = (async () => {
    inside.add(sessionID)
    try {
      await restart(sessionID, mode, size)
    } finally {
      inside.delete(sessionID)
    }
  })()
  relaunching.set(sessionID, run)
  try {
    await run
  } finally {
    if (relaunching.get(sessionID) === run) relaunching.delete(sessionID)
  }
}

async function restart(sessionID: string, mode: Mode | boolean, size: { width: number; height: number }) {
  const target: Mode = mode === true ? "window" : mode === false ? "headless" : mode
  if (target === "capture" && process.platform !== "win32")
    throw new Error("Showing the real Chrome window in the pane works on Windows only.")
  await open(sessionID)
  const item = live.get(sessionID)!
  if (modeOf(sessionID) === target) return
  const urls = (await BrowserTabs.list(item.port)).map((tab) => tab.url).filter((url) => /^https?:\/\//i.test(url))
  unwatch(sessionID)
  orders.delete(sessionID)
  live.delete(sessionID)
  item.client.close()
  item.capture?.stop()
  await quit(item.port)
  const exe = Chrome.find(existsSync)
  if (!exe) throw new Error("Google Chrome or Microsoft Edge was not found.")
  const headed = target !== "headless"
  calm(Chrome.profileDir(Global.Path.data, sessionID))
  const run = await Chrome.launch(headed ? windowDeps : deps, {
    exe,
    profileDir: Chrome.profileDir(Global.Path.data, sessionID),
    headless: !headed,
    url: START_PAGE,
    urls,
    extraArgs:
      target === "capture"
        ? [
            ...WindowCapture.KEEP_PAINTING_FLAGS,
            `--window-position=${WindowCapture.OFFSCREEN.x},${WindowCapture.OFFSCREEN.y}`,
            `--window-size=${size.width},${size.height}`,
          ]
        : [],
  })
  const next = await join(run.port, target === "window" ? () => {} : run.close, target === "window")
  if (target !== "window") await awake(next.client)
  if (target === "capture") {
    if (run.pid === undefined) throw new Error("Chrome did not report a process id.")
    const script = helperFile()
    try {
      next.capture = await WindowCapture.start(
        () => {
          const child = spawn(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
            { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
          )
          return {
            write: (line) => void child.stdin.write(line + "\n"),
            kill: () => child.kill(),
            onLine: (listener) => {
              let buffer = ""
              child.stdout.on("data", (chunk: Buffer) => {
                buffer += chunk.toString("utf8")
                const lines = buffer.split("\n")
                buffer = lines.pop() ?? ""
                lines.forEach(listener)
              })
            },
            onExit: (listener) => void child.once("exit", listener),
          }
        },
        run.pid,
        size,
      )
    } catch (error) {
      // Capture did not work here: leave the operator with the streamed, windowless Chrome rather than nothing.
      next.client.close()
      run.close()
      await quit(run.port).catch(() => undefined)
      await restart(sessionID, "headless", size).catch(() => undefined)
      throw error
    }
  }
  live.set(sessionID, next)
}

const bridgeFile = () => BrowserBridge.file(Global.Path.data)

/** Records the selected browser session of a project for the chat agent's tool. */
export function publishSelection(directory: string, sessionID: string | undefined) {
  const file = bridgeFile()
  const next = BrowserBridge.withSelection(
    BrowserBridge.parse(existsSync(file) ? readFileSync(file, "utf8") : undefined),
    directory,
    sessionID,
  )
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2))
}

/** The browser session selected for the project that owns `directory`. */
export function selectedSession(directory: string) {
  const file = bridgeFile()
  return BrowserBridge.selectedFor(
    BrowserBridge.parse(existsSync(file) ? readFileSync(file, "utf8") : undefined),
    directory,
  )
}
