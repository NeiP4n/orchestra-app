export * as BrowserGuard from "./guard.js"

/**
 * The agent never opens a system browser by itself. Pages are opened with the browser tool, in the Browser tab,
 * on the session's own Chrome profile. A shell command or a desktop "open" that starts a browser, or hands a web
 * address to the system opener, is refused.
 */
export const REFUSAL =
  "Refusing to open a browser outside Orchestra: open pages with the browser tool (action open), which shows them in the Browser tab. Launching msedge, chrome, firefox or a system opener (start, open, xdg-open) for a web address is not allowed."

const BROWSERS = new Set([
  "msedge", "microsoft-edge", "microsoft-edge-stable", "chrome", "google-chrome", "google-chrome-stable", "chromium",
  "chromium-browser", "firefox", "brave", "brave-browser", "opera", "vivaldi", "iexplore", "safari", "arc",
])
const OPENERS = new Set([
  "start", "start-process", "xdg-open", "open", "explorer", "gio", "sensible-browser", "x-www-browser", "gnome-open",
  "wslview", "invoke-item", "ii", "rundll32", "kde-open", "kde-open5",
])
const WRAPPERS = new Set(["cmd", "cmd.exe", "/c", "/k", "powershell", "powershell.exe", "pwsh", "-command", "-c", "call", "sudo", "nohup", "env", "setsid", "exec"])

const base = (token: string) =>
  token
    .replace(/^["'`(]+|["'`);]+$/g, "")
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|app|cmd|bat)$/, "")

const webTarget = (token: string) => /^["'`]?(?:https?:|file:|ftp:|www\.)/i.test(token) || /\.html?["'`]?$/i.test(token)

/** True when a web address (or a browser) is the target of an opener. */
export function opensBrowser(target: string): boolean {
  const tokens = target.trim().split(/\s+/)
  return tokens.some((token) => webTarget(token) || BROWSERS.has(base(token)))
}

/** True when a shell command launches a browser or passes a web address to a system opener. */
export function launchesBrowser(command: string): boolean {
  for (const segment of command.split(/[;&|\n]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    let i = 0
    while (i < tokens.length && (WRAPPERS.has(tokens[i]!.toLowerCase()) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!))) i++
    const head = tokens[i] ? base(tokens[i]!) : ""
    const rest = tokens.slice(i + 1)
    if (BROWSERS.has(head)) {
      // A windowless browser (CI, screenshots, version checks) shows nothing, so it stays allowed.
      if (rest.some((token) => /^--headless/.test(token) || token === "--version" || token === "-version")) continue
      return true
    }
    if (OPENERS.has(head)
      if (rest.some((token) => webTarget(token) || BROWSERS.has(base(token)))) return true
    // A quoted path with spaces (C:\Program Files\...\chrome.exe) is not one token above.
    if (/[\\/](?:chrome|msedge|firefox|brave|opera|vivaldi|iexplore)\.exe/i.test(segment) && !/--headless|--version/i.test(segment)) return true
    // `cmd /c start http://...` and `powershell -c "start http://..."` put the opener inside a quoted string.
    if (/\b(?:start|start-process|xdg-open|invoke-item)\s+(?:""\s+)?["']?(?:https?:|file:|www\.)/i.test(segment)) return true
  }
  return false
}
