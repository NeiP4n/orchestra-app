import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { Global } from "@orchestra/util/global"
import { Cdp } from "@orchestra/core/browser/cdp"
import { Chrome } from "@orchestra/core/browser/chrome"

// Runs the Chrome of each browser session for the Browser view: one process per session on its own
// profile directory, driven over the DevTools protocol. Nothing starts until the operator asks, and
// every process is closed when the TUI exits. The operator's own Chrome profile is never touched.

type Live = { run: Chrome.Running; client: Cdp.Client }

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

async function start(sessionID: string): Promise<Live> {
  const exe = Chrome.find(existsSync)
  if (!exe) throw new Error("Google Chrome was not found. Install it, or set ORCHESTRA_CHROME_PATH to chrome.exe.")
  const run = await Chrome.launch(deps, {
    exe,
    profileDir: Chrome.profileDir(Global.Path.data, sessionID),
    headless: true,
  })
  try {
    const targets = (await (await fetch(`http://127.0.0.1:${run.port}/json/list`)).json()) as Parameters<
      typeof Cdp.pageSocketUrl
    >[0]
    const url = Cdp.pageSocketUrl(targets)
    if (!url) throw new Error("Chrome has no page to drive.")
    const client = await Cdp.connect((address) => new WebSocket(address) as unknown as Cdp.Socket, url)
    return { run, client }
  } catch (error) {
    run.close()
    throw error
  }
}

/** The running browser of a session, started on first use. */
export async function open(sessionID: string): Promise<Live> {
  const existing = live.get(sessionID)
  if (existing) return existing
  const pending = starting.get(sessionID)
  if (pending) return pending
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
  return promise
}

export const isOpen = (sessionID: string) => live.has(sessionID)

export async function go(sessionID: string, address: string) {
  const { client } = await open(sessionID)
  await Cdp.navigate(client, Chrome.normalizeUrl(address))
}

export async function read(sessionID: string) {
  const { client } = await open(sessionID)
  const [info, text] = await Promise.all([Cdp.pageInfo(client), Cdp.pageText(client)])
  return { ...info, text }
}

export function close(sessionID: string) {
  const item = live.get(sessionID)
  if (!item) return
  live.delete(sessionID)
  item.client.close()
  item.run.close()
}

export function closeAll() {
  for (const id of [...live.keys()]) close(id)
}
