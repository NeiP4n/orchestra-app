export * as BrowserRuntime from "./runtime.js"

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Global } from "@orchestra/util/global"
import { BrowserBridge } from "./bridge.js"
import { Cdp } from "./cdp.js"
import { BrowserTabs } from "./tabs.js"
import { Chrome } from "./chrome.js"

// One Chrome per browser session, shared by the Browser tab and the chat agent. A Chrome that already runs
// on the session's profile is joined, never started twice. Chrome starts only when somebody asks, and the
// ones this process started close with it. The operator's own Chrome profile is never used.

interface Live {
  port: number
  tabID: string
  client: Cdp.Client
  /** Closes the process only when this process started it. */
  stop: () => void
}

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
async function join(port: number, stop: () => void): Promise<Live> {
  const tab = (await BrowserTabs.list(port))[0] ?? (await BrowserTabs.create(port))
  return { port, tabID: tab.id, client: await connectTab(tab), stop }
}

async function start(sessionID: string): Promise<Live> {
  const dir = Chrome.profileDir(Global.Path.data, sessionID)
  const port = await Chrome.livePort(deps.readFile, alive, dir)
  if (port !== undefined) return join(port, () => {})
  const exe = Chrome.find(existsSync)
  if (!exe) throw new Error("Google Chrome or Microsoft Edge was not found. Install one, or set ORCHESTRA_CHROME_PATH.")
  const run = await Chrome.launch(deps, { exe, profileDir: dir, headless: true })
  try {
    return await join(run.port, run.close)
  } catch (error) {
    run.close()
    throw error
  }
}

/** The running browser of a session, started (or joined) on first use. */
export async function open(sessionID: string): Promise<Cdp.Client> {
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
  item.stop()
}

export function closeAll() {
  for (const id of [...live.keys()]) close(id)
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
