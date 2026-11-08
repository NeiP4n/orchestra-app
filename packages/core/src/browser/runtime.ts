export * as BrowserRuntime from "./runtime.js"

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Global } from "@orchestra/util/global"
import { BrowserBridge } from "./bridge.js"
import { Cdp } from "./cdp.js"
import { Chrome } from "./chrome.js"

// One Chrome per browser session, shared by the Browser tab and the chat agent. A Chrome that already runs
// on the session's profile is joined, never started twice. Chrome starts only when somebody asks, and the
// ones this process started close with it. The operator's own Chrome profile is never used.

interface Live {
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

async function connect(port: number) {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Parameters<
    typeof Cdp.pageSocketUrl
  >[0]
  const url = Cdp.pageSocketUrl(targets)
  if (!url) throw new Error("Chrome has no page to drive.")
  return Cdp.connect((address) => new WebSocket(address) as unknown as Cdp.Socket, url)
}

async function start(sessionID: string): Promise<Live> {
  const dir = Chrome.profileDir(Global.Path.data, sessionID)
  const port = await Chrome.livePort(deps.readFile, alive, dir)
  if (port !== undefined) return { client: await connect(port), stop: () => {} }
  const exe = Chrome.find(existsSync)
  if (!exe) throw new Error("Google Chrome or Microsoft Edge was not found. Install one, or set ORCHESTRA_CHROME_PATH.")
  const run = await Chrome.launch(deps, { exe, profileDir: dir, headless: true })
  try {
    return { client: await connect(run.port), stop: run.close }
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
  await Cdp.navigate(await open(sessionID), Chrome.normalizeUrl(address))
}

export async function read(sessionID: string) {
  const client = await open(sessionID)
  const [info, text] = await Promise.all([Cdp.pageInfo(client), Cdp.pageText(client)])
  return { ...info, text }
}

const screens = new Map<string, () => void>()

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
  await Cdp.setViewport(client, size.width, size.height)
  screens.set(sessionID, await Cdp.startScreencast(client, size, onFrame))
}

export function unwatch(sessionID: string) {
  screens.get(sessionID)?.()
  screens.delete(sessionID)
}

export function close(sessionID: string) {
  unwatch(sessionID)
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
