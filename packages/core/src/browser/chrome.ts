export * as Chrome from "./chrome.js"

import path from "node:path"

// Google Chrome for the Browser view. Every browser session runs its own Chrome process on its own
// user-data-dir under the app's data folder, so the operator's real Chrome profile is never opened
// (Chrome 136+ also ignores remote debugging on its default profile). Chrome picks a free debugging
// port itself (port 0) and reports it in DevToolsActivePort inside that directory.

/** Where Chrome is usually installed, best first. ORCHESTRA_CHROME_PATH wins when set. Edge is never searched: a session never starts the operator's system browser. */
export const NOT_FOUND = "Google Chrome was not found. Install it from https://www.google.com/chrome/ or set ORCHESTRA_CHROME_PATH to the full path of chrome.exe (or another Chromium you want used)."

export function candidates(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  const custom = env.ORCHESTRA_CHROME_PATH?.trim()
  const list: string[] = custom ? [custom] : []
  if (platform === "win32") {
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA])
      if (base) list.push(path.win32.join(base, "Google", "Chrome", "Application", "chrome.exe"))
  } else if (platform === "darwin") {
    list.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    )
  } else {
    list.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
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

/**
 * Flags that keep a session's Chrome small and out of the way. It has no window (new headless mode), no GPU,
 * extensions, sync, updates or background services, one renderer process, a capped JavaScript heap and a
 * small disk cache. Only the page the operator opened costs memory.
 */
export const LOW_MEMORY_FLAGS = [
  "--disable-gpu",
  "--disable-extensions",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-component-update",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-breakpad",
  "--disable-translate",
  "--disable-hang-monitor",
  "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,CalculateNativeWinOcclusion,InterestFeedContentSuggestions",
  "--metrics-recording-only",
  "--mute-audio",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--renderer-process-limit=1",
  "--disk-cache-size=33554432",
  "--js-flags=--max-old-space-size=384",
]

export function launchArgs(input: {
  profileDir: string
  headless?: boolean
  url?: string
  width?: number
  height?: number
  /** Addresses to open at start (only http and https are kept). */
  urls?: string[]
  /** Extra flags, placed before the addresses. */
  extraArgs?: string[]
}) {
  const urls = (input.urls ?? []).filter((item) => /^https?:\/\//i.test(item))
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${input.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // A Chrome that was stopped without a clean exit must not greet the operator with "Restore pages?".
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    ...(input.headless
      ? ["--headless=new", ...LOW_MEMORY_FLAGS, `--window-size=${input.width ?? 1600},${input.height ?? 1000}`]
      : []),
    ...(input.extraArgs ?? []),
    ...(urls.length > 0 ? urls : [input.url ?? "about:blank"]),
  ]
}

/**
 * Marks the last exit in a profile's Preferences as clean, so Chrome does not offer to restore pages after a
 * stop it did not get to finish. Returns the new text, or undefined when there is nothing to change.
 */
export function cleanExitPreferences(text: string): string | undefined {
  let data: { profile?: { exit_type?: unknown; exited_cleanly?: unknown } }
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!data || typeof data !== "object") return undefined
  if (data.profile?.exit_type === "Normal" && data.profile?.exited_cleanly === true) return undefined
  data.profile = { ...(data.profile ?? {}), exit_type: "Normal", exited_cleanly: true }
  return JSON.stringify(data)
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

/**
 * What the address bar does with typed text, like Chrome's omnibox: an address opens, anything else is a
 * search. Only http and https ever open.
 */
export function omnibox(input: string): string {
  const text = input.trim()
  if (!text) throw new Error("Type an address or something to search for.")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return normalizeUrl(text)
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(text)) return normalizeUrl(`http://${text}`)
  if (!/\s/.test(text) && /^[^\s/:]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(text)) return normalizeUrl(`https://${text}`)
  // javascript:, file:, about: and the like are never searched for or opened.
  if (!/\s/.test(text) && /^(javascript|file|data|about|chrome|view-source|blob):/i.test(text))
    return normalizeUrl(text)
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
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
  ) => { pid?: number; kill: () => void; once: (event: "exit", cb: (code?: number | null) => void) => void }
  /** What Chrome printed on stderr in its last run (tail), to show the real reason when it dies at once. */
  readonly stderrTail?: () => string
  readonly readFile: (file: string) => string | undefined
  readonly sleep: (ms: number) => Promise<void>
  readonly mkdir: (dir: string) => void
  /** Removes a stale DevToolsActivePort so an old port is never mistaken for the new process's. */
  readonly remove: (file: string) => void
}

/**
 * The debugging port of a Chrome that already runs on this profile directory, or undefined. The port file
 * alone is not proof (it stays behind when Chrome dies), so the port must also answer. This lets the Browser
 * tab and the chat agent share one Chrome per browser session instead of fighting over the profile.
 */
export async function livePort(
  readFile: (file: string) => string | undefined,
  alive: (port: number) => Promise<boolean>,
  dir: string,
): Promise<number | undefined> {
  const text = readFile(path.join(dir, "DevToolsActivePort"))
  const active = text === undefined ? undefined : parseActivePort(text)
  if (!active) return undefined
  return (await alive(active.port).catch(() => false)) ? active.port : undefined
}

/** Starts Chrome on the profile directory and waits for its debugging port. Rejects if Chrome exits or never answers. */
export async function launch(
  deps: Deps,
  input: {
    exe: string
    profileDir: string
    headless?: boolean
    url?: string
    urls?: string[]
    extraArgs?: string[]
    timeoutMs?: number
  },
): Promise<Running> {
  deps.mkdir(input.profileDir)
  const portFile = path.join(input.profileDir, "DevToolsActivePort")
  deps.remove(portFile)
  const child = deps.spawn(input.exe, launchArgs(input))
  let exited = false
  let exitCode: number | null | undefined
  child.once("exit", (code) => {
    exited = true
    exitCode = code
  })
  const deadline = Date.now() + (input.timeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    if (exited) {
      const said = deps.stderrTail?.().trim()
      throw new Error(
        `Chrome closed before it was ready (exit code ${exitCode ?? "unknown"}).${said ? ` Chrome said: ${said}` : ""} A Chrome that is still shutting down on the same profile also causes this.`,
      )
    }
    const text = deps.readFile(portFile)
    const active = text === undefined ? undefined : parseActivePort(text)
    if (active) return { port: active.port, pid: child.pid, close: () => child.kill() }
    await deps.sleep(100)
  }
  child.kill()
  throw new Error("Chrome did not report a debugging port in time.")
}
