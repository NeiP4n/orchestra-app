import { spawn } from "node:child_process"
import type { ClipboardContent } from "./context/clipboard"

export const LINUX_PASTE_HINT = "Clipboard unavailable. Use the terminal's Ctrl+Shift+V (or Shift+Insert / middle-click). For Ctrl+V, install wl-clipboard on Wayland or xclip/xsel on X11. Over SSH, use the terminal paste shortcut."
export type ClipboardCommand = readonly [string, ...string[]]

export function linuxClipboardCommands(env: NodeJS.ProcessEnv): ClipboardCommand[] {
  return [
    ...(env.WAYLAND_DISPLAY ? [["wl-paste", "--no-newline", "--type", "text"] as const] : []),
    ...(env.DISPLAY ? [["xclip", "-selection", "clipboard", "-out"] as const, ["xsel", "--clipboard", "--output"] as const] : []),
  ]
}

/** No shell, bounded output and runtime. Never print clipboard contents or stderr. */
export function runClipboardCommand(command: ClipboardCommand): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = spawn(command[0], [...command.slice(1)], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
    const chunks: Buffer[] = []
    let bytes = 0, settled = false
    const finish = (text?: string) => { if (settled) return; settled = true; clearTimeout(timer); resolve(text) }
    const timer = setTimeout(() => { child.kill(); finish() }, 1500)
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) { child.kill(); finish(); return }
      chunks.push(chunk)
    })
    child.on("error", () => finish())
    child.on("close", code => finish(code === 0 ? Buffer.concat(chunks).toString("utf8") : undefined))
  })
}

export function createLinuxClipboardFallback(options: {
  environment?: NodeJS.ProcessEnv
  run?: (command: ClipboardCommand) => Promise<string | undefined>
} = {}) {
  return async (): Promise<ClipboardContent | undefined> => {
    const environment = options.environment ?? process.env
    // A remote shell must not paste from the server's unrelated desktop clipboard.
    if (environment.SSH_CONNECTION || environment.SSH_TTY || environment.SSH_CLIENT) throw new Error(LINUX_PASTE_HINT)
    for (const command of linuxClipboardCommands(environment)) {
      const text = await (options.run ?? runClipboardCommand)(command)
      if (text !== undefined) return text.length ? { data: text, mime: "text/plain" } : undefined
    }
    throw new Error(LINUX_PASTE_HINT)
  }
}
