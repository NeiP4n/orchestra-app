export * as BrowserRuntime from "./runtime.js"

import { freemem, totalmem } from "node:os"
import { spawn } from "node:child_process"
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs"
import path from "node:path"
import { Flock } from "@orchestra/util/flock"
import { readdirSync } from "node:fs"
import * as BrowserActivity from "./activity.js"
import { BrowserLifecycle } from "./lifecycle.js"
import { BrowserBudget } from "./budget.js"
import { Global } from "@orchestra/util/global"
import { BrowserBridge } from "./bridge.js"
import { Cdp } from "./cdp.js"
import { BrowserTabs } from "./tabs.js"
import { BrowserKeyQueue } from "./key-queue.js"
import { BrowserWatch } from "./watch.js"
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
// CDP reconnection must not lose ownership of a Chrome we launched. Eviction
// drops the socket, not this cleanup handle; never register the user's Chrome.
const ownedChrome = new Map<number, () => void>()
function rememberOwned(run: Chrome.Running): Chrome.Running {
  const stop = () => { ownedChrome.delete(run.port); run.close() }
  ownedChrome.set(run.port, stop)
  return { ...run, close: stop }
}
let hooked = false

// Chrome's stderr goes to a small file, so a Chrome that dies at once says why instead of failing silently.
const stderrFile = () => path.join(Global.Path.data, "browser-profiles", "chrome-stderr.log")
// Past a few launches' worth of output the oldest generation rotates aside;
// one previous file is kept so a crash's last lines survive the relaunch.
const STDERR_LIMIT = 64 * 1024
function stderrFd(): "ignore" | number {
  try {
    const file = stderrFile()
    mkdirSync(path.dirname(file), { recursive: true })
    // Append, never truncate: the "w" mode used to wipe the evidence of the
    // crash that triggered the relaunch opening the file.
    try {
      if (statSync(file).size > STDERR_LIMIT) renameSync(file, `${file}.old`)
    } catch {}
    const fd = openSync(file, "a")
    writeSync(fd, `\n--- chrome launch ${new Date().toISOString()} ---\n`)
    return fd
  } catch {
    return "ignore"
  }
}
const stderrTail = () => {
  let text = ""
  try {
    text = readFileSync(stderrFile(), "utf8")
  } catch {}
  // A fresh file after a rotation is short: reach into the previous
  // generation, where the crash that triggered the relaunch spoke last.
  if (text.length < 400) {
    try {
      text = readFileSync(`${stderrFile()}.old`, "utf8") + text
    } catch {}
  }
  return text.slice(-400)
}
const processFile = (dir: string) => path.join(dir, "orchestra-managed-process.json")
function recordProcess(pid: number | undefined, args: string[]) {
  const dir = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length)
  if (!dir || !pid) return
  // Fail before another launch if the new Chrome remains alive but CDP hangs.
  // This file is only for refusal/probing. Never kill a PID read from disk.
  writeAtomic(processFile(dir), JSON.stringify({ pid }))
}
function forgetProcess(pid: number | undefined, args: string[]) {
  const dir = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length)
  if (!dir || !pid) return
  try { if (JSON.parse(readFileSync(processFile(dir), "utf8")).pid === pid) rmSync(processFile(dir), { force: true }) } catch {}
}
const deps: Chrome.Deps = {
  stderrTail,
  spawn: (exe, args) => {
    const fd = stderrFd()
    const child = spawn(exe, args, { stdio: ["ignore", "ignore", fd], windowsHide: true })
    try { recordProcess(child.pid, args) } catch (error) { child.kill(); if (typeof fd === "number") closeSync(fd); throw error }
    child.once("exit", () => { forgetProcess(child.pid, args); if (typeof fd === "number") closeSync(fd) })
    return child
  },
  readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
  remove: (file) => rmSync(file, { force: true }),
}

const alive = async (port: number, expectedPath?: string) => {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
  return response.ok && (!expectedPath || BrowserBudget.matchesEndpoint(await response.json(), expectedPath))
}

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
  spawn: (exe, args) => {
    const fd = stderrFd()
    const child = spawn(exe, args, { stdio: ["ignore", "ignore", fd], windowsHide: false })
    try { recordProcess(child.pid, args) } catch (error) { child.kill(); if (typeof fd === "number") closeSync(fd); throw error }
    child.once("exit", () => { forgetProcess(child.pid, args); if (typeof fd === "number") closeSync(fd) })
    return child
  },
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
    if (!(await alive(port).catch(() => false))) { ownedChrome.delete(port); return }
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

const launchLock = <T>(action: () => Promise<T>) => Flock.withLock("browser-active-profile-budget", action, {
  dir: path.join(Global.Path.data, "browser-launch-locks"), timeoutMs: 5000, baseDelayMs: 50, maxDelayMs: 100,
})
export const browserLimitDetails = (error: unknown) => error instanceof BrowserBudget.LimitError
  ? { sessionID: error.sessionID, name: error.sessionName, canClose: error.reason === "cdp" } : undefined
async function checkLaunchBudget(sessionID?: string): Promise<number | undefined> {
  // Joining one's own profile does not consume a new slot, even if another legacy profile also exists.
  if (sessionID) {
    const own = await Chrome.livePort(deps.readFile, alive, Chrome.profileDir(Global.Path.data, sessionID))
    if (own !== undefined) return own
  }
  const maximum = process.env.ORCHESTRA_BROWSER_LIMIT === "off" ? Infinity : BrowserBudget.configuredMax(process.env.ORCHESTRA_BROWSER_MAX)
  let count = 0
  const warning = BrowserBudget.memoryWarning(freemem())
  if (warning) trace(warning)
  const root = path.join(Global.Path.data, "browser-profiles")
  let folders: string[] = []
  if (existsSync(root)) folders = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]{1,64}$/.test(entry.name)).map((entry) => entry.name)
  for (const id of folders) {
    const dir = Chrome.profileDir(Global.Path.data, id)
    let name = id
    try { name = sessions().find((item) => item.id === id)?.name || id } catch {}
    const port = await Chrome.livePort(deps.readFile, alive, dir)
    if (port !== undefined) {
      if (id === sessionID) return port
      count++; continue
    }
    const file = processFile(dir)
    if (!existsSync(file)) continue // Legacy profiles may predate PID tracking.
    let pid: number
    try { pid = JSON.parse(readFileSync(file, "utf8")).pid; if (!Number.isSafeInteger(pid) || pid < 1) throw new Error() }
    catch { if (id === sessionID) throw new BrowserBudget.LimitError(id, name, "record"); count++; continue }
    let dead = false
    try { process.kill(pid, 0) }
    catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH" }
    if (!dead) { if (id === sessionID) throw new BrowserBudget.LimitError(id, name, "pid"); count++; continue }
    // Dead PID is not a blocker. Remove only this stale tracking record, never the profile or its logins.
    try { if (JSON.parse(readFileSync(file, "utf8")).pid === pid) rmSync(file, { force: true }) } catch {}
  }
  BrowserBudget.requireRoom(count, maximum)
}
export const browserState = BrowserActivity.get
export const subscribeBrowserState = BrowserActivity.subscribe

/** Local process view, not a Chromium subprocess count. Never launches or reads a website. */
export function browserResources() {
  const bytes = freemem()
  return { connectedProfiles: live.size, freeGB: (bytes / 1024 ** 3).toFixed(1), totalGB: (totalmem() / 1024 ** 3).toFixed(0), warning: BrowserBudget.memoryWarning(bytes) }
}
/** Verify only this Orchestra profile's local CDP identity. Does not join, launch or read a page. */
export async function profileRunning(sessionID: string): Promise<boolean> {
  const dir = Chrome.profileDir(Global.Path.data, sessionID)
  return (await Chrome.livePort(deps.readFile, alive, dir)) !== undefined
}
/** Explicit operator action only; no launches and no PID loaded from disk is killed. */
export async function closeBlockedBrowser(sessionID: string) {
  // A user stop is durable across TUI/server processes and restarts. No sweep may undo it.
  const marker = watcherStopFile(sessionID)
  mkdirSync(path.dirname(marker), { recursive: true })
  writeAtomic(marker, JSON.stringify({ stoppedAt: Date.now() }))
  BrowserActivity.set(sessionID, { phase: "stopping" })
  unwatch(sessionID)
  try { return await launchLock(async () => {
    const dir = Chrome.profileDir(Global.Path.data, sessionID)
    const port = await Chrome.livePort(deps.readFile, alive, dir)
    let trackedPID: number | undefined
    try { trackedPID = JSON.parse(readFileSync(processFile(dir), "utf8")).pid } catch {}
    if (port !== undefined) await within(quit(port), 12_000)
    else {
      const file = processFile(dir)
      if (existsSync(file)) {
        let pid: number
        try { pid = JSON.parse(readFileSync(file, "utf8")).pid; if (!Number.isSafeInteger(pid) || pid < 1) throw new Error() }
        catch { throw new Error("Запись процесса повреждена. Профиль и логины не удалены.") }
        let dead = false
        try { process.kill(pid, 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH" }
        if (!dead) throw new Error("Chrome этой сессии не отвечает. Завершение по сохранённому PID запрещено; чужой Chrome не затронут.")
        try { if (JSON.parse(readFileSync(file, "utf8")).pid === pid) rmSync(file, { force: true }) } catch {}
      }
    }
    await BrowserActivity.verifyStopped({
      portAlive: () => port === undefined ? Promise.resolve(false) : alive(port).catch(() => false),
      pidAlive: () => {
        if (!Number.isSafeInteger(trackedPID) || trackedPID! < 1) return false
        try { process.kill(trackedPID!, 0); return true }
        catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" }
      },
      sleep: deps.sleep,
    })
    evict(sessionID)
    // DevToolsActivePort is connection metadata only, not cookies or credentials.
    rmSync(path.join(dir, "DevToolsActivePort"), { force: true })
    BrowserActivity.set(sessionID, { phase: "stopped" })
  }) } catch (error) {
    BrowserActivity.set(sessionID, { phase: "error", reason: error instanceof Error ? error.message : "Не удалось остановить Chrome" })
    throw error
  }
}
async function start(sessionID: string, passive = false): Promise<Live> {
  return launchLock(() => {
    if (passive && existsSync(watcherStopFile(sessionID))) throw new Error("Chrome остановлен оператором")
    return startLocked(sessionID)
  })
}
async function startLocked(sessionID: string): Promise<Live> {
  const dir = Chrome.profileDir(Global.Path.data, sessionID)
  const port = await Chrome.livePort(deps.readFile, alive, dir)
  if (port !== undefined) return join(port, ownedChrome.get(port) ?? (() => {}))
  const joinedPort = await checkLaunchBudget(sessionID)
  if (joinedPort !== undefined) return join(joinedPort, ownedChrome.get(joinedPort) ?? (() => {}))
  const exe = Chrome.find(existsSync)
  if (!exe) throw new Error(Chrome.NOT_FOUND)
  calm(dir)
  const urls = savedTabs(sessionID)
  if (urls.length > 0) trace(`${sessionID}: Chrome was not running, reopening ${urls.length} saved tab(s)`)
  trace(`${sessionID}: starting ${exe} windowless on ${dir} (pid ${process.pid})`)
  const run = rememberOwned(await Chrome.launch(deps, { exe, profileDir: dir, headless: true, url: START_PAGE, urls }))
  try {
    return await join(run.port, run.close)
  } catch (error) {
    run.close()
    throw error
  }
}

/** The running browser of a session, started (or joined) on first use. */
export async function open(sessionID: string, options: { passive?: boolean } = {}): Promise<Cdp.Client> {
  if (BrowserActivity.get(sessionID)?.phase === "stopping") throw new Error("Chrome останавливается. Дождитесь завершения остановки.")
  // A restart in progress owns the session: starting another Chrome beside it is what left input hanging.
  const restarting = relaunching.get(sessionID)
  if (restarting && !inside.has(sessionID)) await restarting.catch(() => undefined)
  if (!inside.has(sessionID)) await awaitRelaunch(sessionID)
  if (!options.passive) {
    rmSync(watcherStopFile(sessionID), { force: true })
    watcherRestoreAttempted.delete(sessionID)
  }
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
  const wanted = savedState(sessionID).active
  BrowserActivity.set(sessionID, { phase: "starting" })
  const promise = start(sessionID, options.passive)
    .then(async (value) => {
      live.set(sessionID, value)
      BrowserActivity.set(sessionID, { phase: "running" })
      // After a restart the tab that was in front comes back in front (best effort, the tabs themselves are enough).
      if (wanted) {
        try {
          const tab = (await BrowserTabs.list(value.port)).find((entry) => entry.url === wanted)
          if (tab) await switchTo(sessionID, tab)
        } catch (error) {
          trace(`${sessionID}: restoring the active tab failed: ${String(error).slice(0, 120)}`)
        }
      }
      return value
    })
    .catch((error) => {
      BrowserActivity.set(sessionID, { phase: "error", reason: error instanceof Error ? error.message : "Не удалось запустить Chrome" })
      throw error
    })
    .finally(() => starting.delete(sessionID))
  starting.set(sessionID, promise)
  return (await promise).client
}

export const isOpen = (sessionID: string) => live.has(sessionID)

// Browser triggers: arms the page watcher on the session's current page connection. A tab switch, a restart or a new
// Chrome gives the session a new connection, so the trigger sweep calls this again every few seconds and it re-arms when
// the connection changed. It never starts Chrome: a session that is not running is not watched.
const watcherStopFile = (sessionID: string) => path.join(Global.Path.data, "browser-profiles", encodeURIComponent(sessionID) + ".watcher-stopped.json")
const watcherRestoreAttempted = new Set<string>()
const watcherReasons = new Map<string, string>()
export const watcherReason = (sessionID: string) => watcherReasons.get(sessionID)
/** Enabled durable triggers restore once at service startup. A user stop always wins until explicit enable/start. */
export async function watchRestore(sessionID: string): Promise<void> {
  if (await watchEnsure(sessionID)) { watcherReasons.delete(sessionID); return }
  if (existsSync(watcherStopFile(sessionID))) { watcherReasons.set(sessionID, "Ждёт запуска браузера: Chrome остановлен оператором. Нажмите ▶ или включите триггер заново."); return }
  if (watcherRestoreAttempted.has(sessionID)) return
  watcherRestoreAttempted.add(sessionID)
  try {
    await open(sessionID, { passive: true })
    if (!await watchEnsure(sessionID)) throw new Error("Страница не готова к наблюдению. Откройте сохранённую страницу и проверьте вход в аккаунт.")
    watcherReasons.delete(sessionID)
  } catch (error) {
    watcherReasons.set(sessionID, "Ждёт запуска браузера: " + (error instanceof Error ? error.message : "Не удалось запустить Chrome").slice(0, 180))
  }
}
/** Explicit create/resume is permission to start this already-resolved managed profile, not arbitrary page actions. */
export async function watchActivate(sessionID: string): Promise<boolean> {
  rmSync(watcherStopFile(sessionID), { force: true })
  watcherRestoreAttempted.delete(sessionID)
  await watchRestore(sessionID)
  return watchEnsure(sessionID)
}
const armed = new Map<string, Cdp.Client>()
const watchHealth = new Map<string, { at: number; state: "ok" | "lost"; resumed: boolean }>()
export const watcherHealth = (sessionID: string) => watchHealth.get(sessionID)
export async function watchEnsure(sessionID: string): Promise<boolean> {
  if (existsSync(watcherStopFile(sessionID))) return false
  // The pane may own Chrome in another process. Join an existing profile only;
  // peek does not start a stopped browser.
  const previous = live.get(sessionID)
  if (previous?.client.isClosed?.() === true) evict(sessionID)
  if (!live.has(sessionID)) await within(peek(sessionID), 4000).catch(() => undefined)
  const item = live.get(sessionID)
  if (!item || item.client.isClosed?.() === true) {
    armed.delete(sessionID)
    return false
  }
  // The visible pane and scheduler are separate processes. Follow the persisted selected tab
  // without opening a tab, activating a window, streaming images or navigating a page.
  const wanted = savedState(sessionID).active
  if (wanted) {
    try {
      const target = (await within(BrowserTabs.list(item.port), 2000)).find(tab => tab.url === wanted)
      if (target && target.id !== item.tabID) {
        const previousClient = item.client
        item.client = await within(connectTab(target), 2000)
        item.tabID = target.id
        previousClient.close()
      }
    } catch { /* heartbeat below remains the readiness check */ }
  }
  const health = watchHealth.get(sessionID)
  const now = Date.now()
  try {
    // Protocol heartbeat only, no website HTTP request, DOM read, image or arbitrary page code.
    await within(item.client.send("Page.setWebLifecycleState", { state: "active" }), 2000)
    await within(item.client.send("Runtime.getIsolateId"), 2000)
    const resumed = health !== undefined && now - health.at > 120_000
    if (resumed) trace(`${sessionID}: watcher heartbeat resumed after a gap; system sleep vs suspended service cannot be distinguished here`)
    await within(BrowserWatch.install(sessionID, item.client), 5000)
    if (!await within(BrowserWatch.ready(item.client), 2000)) {
      armed.delete(sessionID)
      watchHealth.set(sessionID, { at: now, state: "lost", resumed: false })
      return false
    }
    armed.set(sessionID, item.client)
    watcherReasons.delete(sessionID)
    watchHealth.set(sessionID, { at: now, state: "ok", resumed })
    return true
  } catch (error) {
    armed.delete(sessionID)
    watchHealth.set(sessionID, { at: now, state: "lost", resumed: false })
    // Drop only this socket. Next ensure re-joins the existing endpoint; never launch Chrome for a heartbeat.
    if (live.get(sessionID) === item) evict(sessionID)
    trace(`${sessionID}: arming the page watcher failed: ${String(error).slice(0, 120)}`)
    return false
  }
}
export async function stopPageWatcher(sessionID: string) {
  const client = armed.get(sessionID)
  armed.delete(sessionID); watchHealth.delete(sessionID)
  if (client) await within(BrowserWatch.uninstall(client), 3000).catch(() => undefined)
}
BrowserWatch.setEnsurer(watchEnsure)

export async function go(sessionID: string, address: string) {
  await Cdp.navigate(await open(sessionID), Chrome.omnibox(address))
  await tabs(sessionID)
}

export async function read(sessionID: string) {
  const client = await open(sessionID)
  const [info, text] = await Promise.all([Cdp.pageInfo(client), Cdp.pageText(client)])
  return { ...info, text }
}

const screens = new Map<string, () => void>()
const streamStarts = new Map<string, Promise<void>>()
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
  const client = live.get(sessionID)?.client
  if (!client || client.isClosed?.()) throw new Error("Chrome этой сессии остановлен. Нажмите «Открыть Chrome».")
  unwatch(sessionID)
  const capture = live.get(sessionID)?.capture
  if (capture) return capture.watch(size, onFrame)
  watchers.set(sessionID, { size, onFrame })
  await stream(sessionID, client)
}

async function stream(sessionID: string, client: Cdp.Client) {
  const watcher = watchers.get(sessionID)
  if (!watcher) return
  // Serialize stop/start handshakes. A late start acknowledgement from an old
  // viewport must not replace (or stop) the newer stream after a resize/retry.
  const task = (streamStarts.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (watchers.get(sessionID) !== watcher || live.get(sessionID)?.client !== client) return
    await Cdp.setViewport(client, watcher.size.width, watcher.size.height)
    if (watchers.get(sessionID) !== watcher || live.get(sessionID)?.client !== client) return
    const stop = await Cdp.startScreencast(client, watcher.size, (frame) => {
      if (watchers.get(sessionID) === watcher) watcher.onFrame(frame)
    })
    if (watchers.get(sessionID) !== watcher || live.get(sessionID)?.client !== client) { stop(); return }
    screens.set(sessionID, stop)
  })
  streamStarts.set(sessionID, task)
  try { await task }
  finally { if (streamStarts.get(sessionID) === task) streamStarts.delete(sessionID) }
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
function saveTabs(sessionID: string, list: ReadonlyArray<{ url: string; title?: string; active?: boolean }>) {
  const web = list.filter((tab) => /^https?:\/\//i.test(tab.url))
  if (web.length === 0) return
  // Only address, title and order are kept (and which tab was in front): never cookies, storage or page content.
  const text = JSON.stringify({
    tabs: web.map((tab) => ({ url: tab.url, title: (tab.title ?? "").slice(0, 200) })),
    active: web.find((tab) => tab.active)?.url,
  })
  try {
    if (existsSync(tabsFile(sessionID)) && readFileSync(tabsFile(sessionID), "utf8") === text) return
    mkdirSync(path.dirname(tabsFile(sessionID)), { recursive: true })
    writeAtomic(tabsFile(sessionID), text)
  } catch {}
}
function savedState(sessionID: string): { urls: string[]; active?: string } {
  try {
    const value = JSON.parse(readFileSync(tabsFile(sessionID), "utf8")) as unknown
    // The first version wrote a bare list of addresses; both forms are read.
    const raw = Array.isArray(value) ? value : (value as { tabs?: unknown })?.tabs
    const urls = (Array.isArray(raw) ? raw : [])
      .map((entry) => (typeof entry === "string" ? entry : (entry as { url?: unknown })?.url))
      .filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url))
      .slice(0, 8)
    const active = Array.isArray(value) ? undefined : (value as { active?: unknown })?.active
    return { urls, active: typeof active === "string" && urls.includes(active) ? active : undefined }
  } catch {
    return { urls: [] }
  }
}
const savedTabs = (sessionID: string) => savedState(sessionID).urls

/** The session's tabs as Chrome lists them now. The active one is repaired if its tab was closed by the page. */
export async function tabs(sessionID: string): Promise<TabState[]> {
  // Passive UI polling must never restart a profile the operator just stopped.
  const item = live.get(sessionID)
  if (!item || item.client.isClosed?.() || BrowserActivity.get(sessionID)?.phase === "stopping") return []
  const list = ordered(sessionID, await BrowserTabs.list(item.port))
  // A read never opens anything: the pane polls this, and a list that is empty for a moment (Chrome starting, a
  // capture restart) must not grow a blank tab on every poll. Tabs open only by an explicit newTab / closeTab / the agent.
  if (list.length === 0) return []
  saveTabs(sessionID, list.map((tab) => ({ url: tab.url, title: tab.title, active: tab.id === live.get(sessionID)?.tabID })))
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
  await tabs(sessionID)
}

/** Opens a new tab and switches to it. */
export async function newTab(sessionID: string, address?: string) {
  await open(sessionID)
  const item = live.get(sessionID)!
  const tab = await BrowserTabs.create(item.port, address ? Chrome.normalizeUrl(address) : undefined)
  await switchTo(sessionID, tab)
  await tabs(sessionID)
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
  // The operator's own clicks (opening a chat loads old rows) are not news for a browser trigger.
  BrowserWatch.mute(sessionID, 4000)
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

const enqueueKey = BrowserKeyQueue.make()
export function key(sessionID: string, input: Parameters<typeof Cdp.key>[1]): Promise<string> {
  return enqueueKey(sessionID, input, (copy) => deliverKey(sessionID, copy))
}
async function deliverKey(sessionID: string, input: Parameters<typeof Cdp.key>[1]): Promise<string> {
  BrowserWatch.mute(sessionID, 4000)
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
  return closeBlockedBrowser(sessionID)
}

/**
 * A normal stop of the service: each OWNED windowless Chrome is asked to quit (Browser.close), so it writes its cookies
 * and session to the profile; one that has not closed within the timeout is stopped outright.
 */
export async function closeAllGraceful(timeoutMs = 4000) {
  const items = [...live].filter(([, item]) => !item.windowed)
  await Promise.all(
    items.map(async ([id, item]) => {
      unwatch(id)
      live.delete(id)
      item.client.close()
      item.capture?.stop()
      // Joining a pane-owned Chrome for background observation is not ownership.
      // An observer service exiting must not close the other process's browser.
      if (!ownedChrome.has(item.port)) return
      const closed = await Promise.race([
        quit(item.port).then(() => true, () => false),
        new Promise<boolean>((done) => setTimeout(() => done(false), timeoutMs)),
      ])
      if (!closed) {
        trace(`${id}: Chrome did not close in ${timeoutMs} ms on shutdown, stopping it`)
        item.stop()
      }
    }),
  )
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
  // Includes a launched process whose CDP socket was evicted before shutdown.
  for (const stop of [...ownedChrome.values()]) stop()

}

export const isWindowed = (sessionID: string) => live.get(sessionID)?.windowed === true

export type Mode = "headless" | "window" | "capture"

/** Why the last capture attempt of a session did not hold (the helper failed, or the window printed blank). The pane shows it. */
const captureProblems = new Map<string, string>()
// Sessions whose window printed blank with the GPU on (DWM / hardware composition): the next capture of them runs Chrome with
// software compositing, which PrintWindow can read. Slower (more CPU, no GPU video or WebGL speed), so only after a blank print.
const softwareCapture = new Set<string>()
export const softwareCaptureOf = (sessionID: string) => softwareCapture.has(sessionID)
// The last attempt, after software compositing also printed blank: no layered/alpha-0 window, only kept off screen.
const noLayerCapture = new Set<string>()
// A retry (software, then no-layer) is running: the pane says so instead of "fast view because blank".
const retrying = new Set<string>()
export const captureAttemptOf = (sessionID: string) =>
  noLayerCapture.has(sessionID) ? "no-layered" : softwareCapture.has(sessionID) ? "software" : "gpu"
export const captureRetrying = (sessionID: string) => retrying.has(sessionID)
export const captureProblemOf = (sessionID: string) => captureProblems.get(sessionID)

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
  if (target === "capture") captureProblems.delete(sessionID)
  const urls = (await BrowserTabs.list(item.port)).map((tab) => tab.url).filter((url) => /^https?:\/\//i.test(url))
  unwatch(sessionID)
  orders.delete(sessionID)
  live.delete(sessionID)
  item.client.close()
  item.capture?.stop()
  await quit(item.port)
  const exe = Chrome.find(existsSync)
  if (!exe) throw new Error(Chrome.NOT_FOUND)
  const headed = target !== "headless"
  calm(Chrome.profileDir(Global.Path.data, sessionID))
  trace(`${sessionID}: restarting ${exe} as ${target} on ${Chrome.profileDir(Global.Path.data, sessionID)} (pid ${process.pid})`)
  const run = await launchLock(async () => {
    const joinedPort = await checkLaunchBudget(sessionID)
    if (joinedPort !== undefined) return { port: joinedPort, pid: undefined, close: ownedChrome.get(joinedPort) ?? (() => {}), joined: true as const }
    return Chrome.launch(headed ? windowDeps : deps, {
    exe,
    profileDir: Chrome.profileDir(Global.Path.data, sessionID),
    headless: !headed,
    url: START_PAGE,
    urls,
    extraArgs:
      target === "capture"
        ? [
            ...WindowCapture.KEEP_PAINTING_FLAGS,
            ...(softwareCapture.has(sessionID) ? ["--disable-gpu", "--disable-gpu-compositing"] : []),
            // The pane shows the window pixel for pixel: no display scaling, so Chrome's tabs and page keep their
            // normal size instead of being 1.5x larger than the pane the window was sized for.
            `--force-device-scale-factor=${CAPTURE_SCALE}`,
            `--window-position=${WindowCapture.OFFSCREEN.x},${WindowCapture.OFFSCREEN.y}`,
            // The window size is in scaled units, so the pixels on screen still match the pane.
            `--window-size=${Math.round(WindowCapture.captureSize(size).width / CAPTURE_SCALE)},${Math.round(WindowCapture.captureSize(size).height / CAPTURE_SCALE)}`,
          ]
        : [],
    })
  })
  if ("joined" in run) {
    live.set(sessionID, await join(run.port, run.close))
    trace(`${sessionID}: same profile answered during mode switch; joined existing Chrome without another launch`)
    return
  }
  const owned = target === "window" ? run : rememberOwned(run)
  const next = await join(owned.port, target === "window" ? () => {} : owned.close, target === "window").catch((error) => {
    run.close()
    throw error
  })
  if (target !== "window") await awake(next.client)
  if (target === "capture") {
    if (run.pid === undefined) { run.close(); next.client.close(); throw new Error("Chrome did not report a process id.") }
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
        noLayerCapture.has(sessionID),
      )
      // The window prints blank, or cannot be kept invisible: the pane would show black or Chrome over the terminal.
      // Back to the windowless Chrome (the pane draws its own tab strip there), once.
      let reported = false
      next.capture.onProblem((text) => {
        if (reported) return
        reported = true
        captureProblems.set(sessionID, text)
        // A blank print is the GPU-composited window: PrintWindow already runs with PW_RENDERFULLCONTENT (2), so the one
        // remaining try is the same window with software compositing. Only if that prints blank too, the windowless Chrome.
        if (/blank/i.test(text) && (!softwareCapture.has(sessionID) || !noLayerCapture.has(sessionID))) {
          const step = !softwareCapture.has(sessionID) ? "software compositing" : "a window without the alpha-0 trick"
          if (!softwareCapture.has(sessionID)) softwareCapture.add(sessionID)
          else noLayerCapture.add(sessionID)
          retrying.add(sessionID)
          trace(`${sessionID}: window capture problem (${text}), trying once more with ${step}`)
          void relaunch(sessionID, "headless", size)
            .then(() => relaunch(sessionID, "capture", size))
            .catch(() => relaunch(sessionID, "headless", size).catch(() => undefined))
            .finally(() => retrying.delete(sessionID))
          return
        }
        trace(`${sessionID}: window capture problem (${text}), back to the windowless Chrome`)
        void relaunch(sessionID, "headless", size).catch(() => undefined)
      })
    } catch (error) {
      // Capture did not work here: leave the operator with the streamed, windowless Chrome rather than nothing.
      captureProblems.set(sessionID, error instanceof Error ? error.message : String(error))
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
  return BrowserBridge.parseSessions(existsSync(file) ? readFileSync(file, "utf8") : undefined).filter((item) => !item.chat || !BrowserLifecycle.retired(item.chat))
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
      await open(sessionID, { passive: true })
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
