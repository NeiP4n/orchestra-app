export * as Chrome from "./chrome.js"

import path from "node:path"

// Google Chrome for the Browser view. Every browser session runs its own Chrome process on its own
// user-data-dir under the app's data folder, so the operator's real Chrome profile is never opened
// (Chrome 136+ also ignores remote debugging on its default profile). Chrome picks a free debugging
// port itself (port 0) and reports it in DevToolsActivePort inside that directory.

/** Where Chrome is usually installed, best first. ORCHESTRA_CHROME_PATH wins when set. */
export function candidates(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  const custom = env.ORCHESTRA_CHROME_PATH?.trim()
  const list: string[] = custom ? [custom] : []
  if (platform === "win32") {
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA])
      if (base) list.push(path.win32.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    // Edge is Chromium with the same DevTools protocol; it is only the fallback when Chrome is missing.
    for (const base of [env["PROGRAMFILES(X86)"], env.PROGRAMFILES])
      if (base) list.push(path.win32.join(base, "Microsoft", "Edge", "Application", "msedge.exe"))
  } else if (platform === "darwin") {
    list.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    )
  } else {
    list.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
    )
  }
  return list
}

/** The first installed Chrome, or undefined. `exists` is injected so tests need no real install. */
export const find = (
  exists: (file: string) => boolean,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
) => candidates(platform, env).find(exists)

/**
 * The profile directory of one browser session, always inside `root`. The session id must be a plain
 * word so it cannot walk out of the folder or name another program's profile.
 */
export function profileDir(root: string, sessionID: string, join: (...parts: string[]) => string = path.join) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionID)) throw new Error(`Invalid browser session id: ${sessionID}`)
  return join(root, "browser-profiles", sessionID)
}

export function launchArgs(input: { profileDir: string; headless?: boolean; url?: string }) {
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${input.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(input.headless ? ["--headless=new"] : []),
    input.url ?? "about:blank",
  ]
}

/** DevToolsActivePort holds the port on the first line and the browser websocket path on the second. */
export function parseActivePort(text: string): { port: number; path: string } | undefined {
  const [first, second] = text.split(/\r?\n/)
  const port = Number(first?.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { port, path: second?.trim() || "" }
}

/** Only web pages: a typed address must not open files, chrome internals or scripts. */
export function normalizeUrl(input: string): string {
  const text = input.trim()
  if (!text) throw new Error("A web address is needed.")
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  const url = new URL(withScheme)
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`Only http and https addresses open here: ${url.protocol}`)
  return url.toString()
}

export interface Running {
  readonly port: number
  readonly pid: number | undefined
  readonly close: () => void
}

export interface Deps {
  readonly spawn: (
    exe: string,
    args: string[],
  ) => { pid?: number; kill: () => void; once: (event: "exit", cb: () => void) => void }
  readonly readFile: (file: string) => string | undefined
  readonly sleep: (ms: number) => Promise<void>
  readonly mkdir: (dir: string) => void
  /** Removes a stale DevToolsActivePort so an old port is never mistaken for the new process's. */
  readonly remove: (file: string) => void
}

/** Starts Chrome on the profile directory and waits for its debugging port. Rejects if Chrome exits or never answers. */
export async function launch(
  deps: Deps,
  input: { exe: string; profileDir: string; headless?: boolean; url?: string; timeoutMs?: number },
): Promise<Running> {
  deps.mkdir(input.profileDir)
  const portFile = path.join(input.profileDir, "DevToolsActivePort")
  deps.remove(portFile)
  const child = deps.spawn(input.exe, launchArgs(input))
  let exited = false
  child.once("exit", () => (exited = true))
  const deadline = Date.now() + (input.timeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    if (exited) throw new Error("Chrome closed before it was ready. Another Chrome may already be using this profile.")
    const text = deps.readFile(portFile)
    const active = text === undefined ? undefined : parseActivePort(text)
    if (active) return { port: active.port, pid: child.pid, close: () => child.kill() }
    await deps.sleep(100)
  }
  child.kill()
  throw new Error("Chrome did not report a debugging port in time.")
}
