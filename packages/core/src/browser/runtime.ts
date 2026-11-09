export * as BrowserRuntime from "./runtime.js"

import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
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

// ORCHESTRA_BROWSER_SCALE=2 draws Chrome's own tabs and buttons twice as large in the pane, so a terminal's coarse
// pointer can hit them. Default 1 (unchanged behaviour); the page gets that many times fewer CSS pixels.
const CAPTURE_SCALE = Math.min(3, Math.max(1, Number(process.env.ORCHESTRA_BROWSER_SCALE) || 1))

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
/** One line into browser-debug.log (in the app's data folder), so what happened is on disk and not only on screen. */
export function trace(line: string) {
  // Two copies: the app's data folder, and one in the home folder where it is easy to find.
  for (const file of logFiles()) {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      if (existsSync(file) && readFileSync(file).length > 400_000) writeFileSync(file, "")
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // A log that cannot be written must never get in the way.
    }
  }
}

export const logFiles = () => [
  path.join(Global.Path.data, "browser-debug.log"),
  path.join(Global.Path.home, "orchestra-browser-debug.log"),
]

/** What the page is at a point and whether Chrome treats it as visible and focused: the facts a dead click needs. */
async function probe(client: Cdp.Client, x: number, y: number) {
  try {
    const result = (await within(
      client.send("Runtime.evaluate", {
        expression: `(() => { const e = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)}); return JSON.stringify({ at: e ? e.tagName + (e.id ? '#' + e.id : '') + ':' + (e.innerText || e.value || '').slice(0, 24) : null, visible: document.visibilityState, focus: document.hasFocus(), w: innerWidth, h: innerHeight }) })()`,
        returnByValue: true,
      }),
      800,
    )) as { result?: { value?: string } }
    return result.result?.value ?? "no value"
  } catch (error) {
    return `probe failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function awake(client: Cdp.Client) {
  await within(client.send("Emulation.setFocusEmulationEnabled", { enabled: true }), 800).catch(() => undefined)
  await within(client.send("Page.bringToFront"), 800).catch(() => undefined)
  // A window kept off-screen must still count as shown, or Chrome may drop the operator's input.
  await within(client.send("Page.setWebLifecycleState", { state: "active" }), 800).catch(() => undefined)
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
  const urls = savedTabs(sessionID)
  if (urls.length > 0) trace(`${sessionID}: Chrome was not running, reopening ${urls.length} saved tab(s)`)
  const run = await Chrome.launch(deps, { exe, profileDir: dir, headless: true, url: START_PAGE, urls })
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
  if (!inside.has(sessionID)) await awaitRelaunch(sessionID)
  const existing = live.get(sessionID)
  if (existing && existing.client.isClosed?.() === true) {
    // Chrome died or was closed behind our back: the stored client can never answer again. Forget it, so this call
    // joins the Chrome still running on the profile (livePort) or starts a new one.
    trace(`connection of ${sessionID} is closed: reconnecting`)
    evict(sessionID)
  } else if (existing) return existing.client
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

// The open addresses are kept on disk, so a Chrome that died (crash, killed) comes back on the same pages.
const tabsFile = (sessionID: string) => path.join(Global.Path.data, "browser-profiles", `${sessionID}.tabs.json`)
function saveTabs(sessionID: string, urls: string[]) {
  const web = urls.filter((url) => /^https?:\/\//i.test(url))
  if (web.length === 0) return
  try {
    mkdirSync(path.dirname(tabsFile(sessionID)), { recursive: true })
    writeAtomic(tabsFile(sessionID), JSON.stringify(web))
  } catch {}
}
function savedTabs(sessionID: string): string[] {
  try {
    const value = JSON.parse(readFileSync(tabsFile(sessionID), "utf8")) as unknown
    return Array.isArray(value) ? value.filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url)).slice(0, 8) : []
  } catch {
    return []
  }
}

/** The session's tabs as Chrome lists them now. The active one is repaired if its tab was closed by the page. */
export async function tabs(sessionID: string): Promise<TabState[]> {
  await open(sessionID)
  const item = live.get(sessionID)!
  let list = ordered(sessionID, await BrowserTabs.list(item.port))
  if (list.length === 0) list = [await BrowserTabs.create(item.port)]
  saveTabs(sessionID, list.map((tab) => tab.url))
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
    if (input.kind === "down" || input.kind === "up")
      trace(
        `mouse ${input.kind} window ${Math.round(input.x)},${Math.round(input.y)} -> page ${Math.round((input.x - frame.left) / frame.scale)},${Math.round((input.y - frame.top) / frame.scale)} (${frame.raw}) ${input.kind === "down" ? await probe(client, (input.x - frame.left) / frame.scale, (input.y - frame.top) / frame.scale) : ""}`,
      )
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
  if (input.kind !== "move")
    trace(
      `mouse ${input.kind} to the Chrome window at ${Math.round(input.x)},${Math.round(input.y)} (${frame ? frame.raw : `no offset: ${why}`})`,
    )
  capture.mouse(input)
  return `CHROME-UI window ${Math.round(input.x)},${Math.round(input.y)}${frame ? ` (${frame.raw}, top inset ${Math.round(frame.top)}px)` : ` (no inset: ${why || "unknown"})`}`
}

export async function key(sessionID: string, input: Parameters<typeof Cdp.key>[1]): Promise<string> {
  const client = await within(open(sessionID), 3000)
  const capture = live.get(sessionID)?.capture
  if (capture && uiFocus.get(sessionID)) {
    trace(`key ${input.name} -> Chrome window`)
    capture.key(input)
    return "Chrome window"
  }
  // In the real-Chrome window the named editing keys are done inside the page: routed key events were not
  // acting there while typed text was.
  const script = capture && !input.ctrl && !input.meta && !input.option ? Cdp.editKeyScript(input.name) : undefined
  if (script) {
    const result = await within(
      client.send("Runtime.evaluate", { expression: script, returnByValue: true }),
      2000,
    ).catch((error: unknown) => {
      trace(`key ${input.name} FAILED in page: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    })
    const where = result as { result?: { value?: string }; exceptionDetails?: { text?: string } }
    trace(`key ${input.name} -> in the page: ${where.result?.value ?? where.exceptionDetails?.text ?? "no value"}`)
    return "page (script)"
  }
  trace(`key ${input.name} -> page (${Cdp.keySteps(input).length} steps)`)
  await within(Cdp.key(client, input), 2000).catch((error: unknown) => {
    trace(`key ${input.name} FAILED ${error instanceof Error ? error.message : String(error)}`)
    throw error
  })
  return "page"
}

export async function reload(sessionID: string) {
  await (await open(sessionID)).send("Page.reload")
}

/**
 * Deletes the saved profile folder of a session (its logins, cookies and history). Refuses while the session's
 * Chrome runs here. Returns the reason when it could not delete everything, nothing on success.
 */
export function deleteProfile(sessionID: string): string | undefined {
  if (live.has(sessionID)) return "The session's Chrome is running. Close it first."
  try {
    rmSync(Chrome.profileDir(Global.Path.data, sessionID), { recursive: true, force: true })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Drops the stored connection only when it is dead. A restart into another mode (the pane switches the windowless
 * Chrome to the real window right after it starts) replaces the stored Chrome by a healthy one; dropping that
 * one because an older call failed on the old Chrome would kill the pane's browser.
 */
export function evictIfClosed(sessionID: string) {
  if (live.get(sessionID)?.client.isClosed?.() === true) evict(sessionID)
}

/** Drops the stored (dead) connection of a session without asking Chrome to quit. */
export function evict(sessionID: string) {
  unwatch(sessionID)
  orders.delete(sessionID)
  const item = live.get(sessionID)
  if (!item) return
  live.delete(sessionID)
  item.client.close()
  item.capture?.stop()
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

// The pane and the agent's server are different processes: the in-memory `relaunching` map is invisible to the
// server, so a restart in progress is also marked by a small file with a time limit (a crashed pane must not block).
const RELAUNCH_TTL_MS = 20_000
const relaunchFile = (sessionID: string) => path.join(Global.Path.data, "browser-profiles", `${sessionID}.relaunch`)
function markRelaunch(sessionID: string) {
  try {
    mkdirSync(path.dirname(relaunchFile(sessionID)), { recursive: true })
    writeFileSync(relaunchFile(sessionID), String(Date.now()))
  } catch {}
}
function clearRelaunch(sessionID: string) {
  try {
    rmSync(relaunchFile(sessionID), { force: true })
  } catch {}
}
/** Waits while another process restarts this session's Chrome (fresh lock file), at most the lock's time limit. */
export async function awaitRelaunch(sessionID: string) {
  for (;;) {
    let stamp = 0
    try {
      stamp = Number(readFileSync(relaunchFile(sessionID), "utf8"))
    } catch {
      return
    }
    if (!Number.isFinite(stamp) || Date.now() - stamp > RELAUNCH_TTL_MS) return
    await new Promise((done) => setTimeout(done, 250))
  }
}
const inside = new Set<string>()

export async function relaunch(sessionID: string, mode: Mode | boolean, size = { width: 1000, height: 640 }) {
  const before = relaunching.get(sessionID)
  if (before) await before.catch(() => undefined)
  const run = (async () => {
    inside.add(sessionID)
    markRelaunch(sessionID)
    try {
      await restart(sessionID, mode, size)
    } finally {
      inside.delete(sessionID)
      clearRelaunch(sessionID)
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
            // The pane shows the window pixel for pixel: no display scaling, so Chrome's tabs and page keep their
            // normal size instead of being 1.5x larger than the pane the window was sized for.
            `--force-device-scale-factor=${CAPTURE_SCALE}`,
            `--window-position=${WindowCapture.OFFSCREEN.x},${WindowCapture.OFFSCREEN.y}`,
            // The window size is in scaled units, so the pixels on screen still match the pane.
            `--window-size=${Math.round(size.width / CAPTURE_SCALE)},${Math.round(size.height / CAPTURE_SCALE)}`,
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
        undefined,
        (text) => trace(`helper: ${text}`),
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

/**
 * Writes a shared state file (sessions, selection, leases) whole or not at all: a process killed in the middle of a
 * plain write leaves a cut-off file that reads back as empty, and the list of sessions is gone for the agents.
 */
function writeAtomic(file: string, text: string) {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, text)
  renameSync(temp, file)
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
  writeAtomic(file, JSON.stringify(next, null, 2))
}

/** The browser session selected for the project that owns `directory`. */
export function selectedSession(directory: string) {
  const file = bridgeFile()
  return BrowserBridge.selectedFor(
    BrowserBridge.parse(existsSync(file) ? readFileSync(file, "utf8") : undefined),
    directory,
  )
}
let lastPublished = ""
const STARTED_AT = Date.now()
/** The Browser tab publishes every session (name, project) so the agents can list and address them. */
export function publishSessions(list: readonly BrowserBridge.SessionInfo[]) {
  const file = BrowserBridge.sessionsFile(Global.Path.data)
  const text = JSON.stringify(list, null, 2)
  // Right after the Browser tab starts, its project list is not loaded yet and reads empty: that must not wipe the
  // sessions of the last run for the agents (the first questions then saw no browser). A real list replaces it.
  if (list.length === 0 && Date.now() - STARTED_AT < 20_000 && existsSync(file) && BrowserBridge.parseSessions(readFileSync(file, "utf8")).length > 0) {
    trace("sessions: empty list at start, keeping the published ones until the project list loads")
    return
  }
  if (existsSync(file) && readFileSync(file, "utf8") === text) {
    if (lastPublished !== text) {
      lastPublished = text
      trace(
        `sessions already published: ${list.length} in ${file} (${list.map((item) => `${item.name}@${item.project}`).join("; ")})`,
      )
    }
    return
  }
  lastPublished = text
  mkdirSync(path.dirname(file), { recursive: true })
  writeAtomic(file, text)
  trace(
    `sessions published: ${list.length} to ${file} (${list.map((item) => `${item.name}@${item.project}`).join("; ")})`,
  )
}

export const sessionsFilePath = () => BrowserBridge.sessionsFile(Global.Path.data)

export function sessions() {
  const file = BrowserBridge.sessionsFile(Global.Path.data)
  return BrowserBridge.parseSessions(existsSync(file) ? readFileSync(file, "utf8") : undefined)
}

/** An agent's hold on a session ends after a day: an agent that died keeps no session locked for good. */
const LEASE_TTL_MS = 24 * 60 * 60 * 1000

export function leases() {
  const file = BrowserBridge.leasesFile(Global.Path.data)
  const all = BrowserBridge.parseLeases(existsSync(file) ? readFileSync(file, "utf8") : undefined)
  const now = Date.now()
  return Object.fromEntries(
    Object.entries(all).filter(
      ([, lease]) => lease.agent === BrowserBridge.OPERATOR || typeof lease.since !== "number" || now - lease.since < LEASE_TTL_MS,
    ),
  )
}

/** Runs a read-modify-write of leases.json under a lock file (O_EXCL, stale after 5 s), so two processes never lose an update. */
function withLeaseLock<T>(work: () => T): T {
  const lock = `${BrowserBridge.leasesFile(Global.Path.data)}.lock`
  mkdirSync(path.dirname(lock), { recursive: true })
  const until = Date.now() + 2000
  for (;;) {
    try {
      writeFileSync(lock, String(Date.now()), { flag: "wx" })
      break
    } catch {
      let age = 0
      try {
        age = Date.now() - Number(readFileSync(lock, "utf8"))
      } catch {}
      if (age > 5000 || Date.now() > until) {
        rmSync(lock, { force: true })
        if (Date.now() > until) break
      }
    }
  }
  try {
    return work()
  } finally {
    rmSync(lock, { force: true })
  }
}

/** Gives a session to an agent (or the operator), or frees it when `agent` is undefined. */
export function setLease(sessionID: string, agent: string | undefined) {
  const file = BrowserBridge.leasesFile(Global.Path.data)
  mkdirSync(path.dirname(file), { recursive: true })
  withLeaseLock(() => writeAtomic(file, JSON.stringify(BrowserBridge.withLease(leases(), sessionID, agent, Date.now()), null, 2)))
}

/**
 * "Operator took control" belongs to a Browser tab that is open right now. After a crash or a killed terminal it
 * would stay in leases.json and lock the agents out for good, so the Browser tab drops those when it starts.
 */
export function releaseOperatorLeases() {
  const held = leases()
  const stale = Object.entries(held).filter(([, lease]) => lease.agent === BrowserBridge.OPERATOR)
  if (stale.length === 0) return
  const file = BrowserBridge.leasesFile(Global.Path.data)
  writeAtomic(file, JSON.stringify(Object.fromEntries(Object.entries(held).filter(([, lease]) => lease.agent !== BrowserBridge.OPERATOR)), null, 2))
  trace(`dropped ${stale.length} operator lease(s) left by an earlier run: ${stale.map(([id]) => id).join(", ")}`)
}

/** Records where an agent just acted, for the Browser tab to show; ORCHESTRA_AGENT_CURSOR=0 turns it off. */
export function pointAgent(sessionID: string, at: { x: number; y: number } | undefined) {
  if (!at || process.env.ORCHESTRA_AGENT_CURSOR === "0") return
  try {
    const file = BrowserBridge.cursorFile(Global.Path.data)
    const all = BrowserBridge.parseCursors(existsSync(file) ? readFileSync(file, "utf8") : undefined)
    all[sessionID] = { x: at.x, y: at.y, at: Date.now() }
    mkdirSync(path.dirname(file), { recursive: true })
    writeAtomic(file, JSON.stringify(all))
  } catch {
    // The cursor is a courtesy; a failed write never fails the action.
  }
}

export function agentCursor(sessionID: string) {
  const file = BrowserBridge.cursorFile(Global.Path.data)
  return BrowserBridge.parseCursors(existsSync(file) ? readFileSync(file, "utf8") : undefined)[sessionID]
}

/** What a session shows right now, without starting it. */
export async function peek(sessionID: string): Promise<{ running: boolean; title?: string; url?: string }> {
  let item = live.get(sessionID)
  if (!item || item.client.isClosed?.() === true) {
    // The panel may run Chrome in another process: the real Chrome on the session's profile counts, not only our own map.
    const port = await Chrome.livePort(deps.readFile, alive, Chrome.profileDir(Global.Path.data, sessionID)).catch(() => undefined)
    trace(`peek ${sessionID}: profile ${Chrome.profileDir(Global.Path.data, sessionID)}, live port ${port ?? "none"}, own connection ${item ? "closed" : "none"}`)
    if (port === undefined) return { running: false }
    try {
      await open(sessionID)
      item = live.get(sessionID)
    } catch {
      return { running: true }
    }
    if (!item) return { running: true }
  }
  try {
    const info = await Cdp.pageInfo(item.client)
    return { running: true, title: info.title, url: info.url }
  } catch {
    return { running: true }
  }
}
trace(`started, pid ${process.pid}, ${process.platform}, logs: ${logFiles().join(" and ")}`)
