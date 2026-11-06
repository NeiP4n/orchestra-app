export * as DesktopIsolation from "./desktop-isolation.js"

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"

/**
 * Desktop isolation (block B7): the agent never touches the operator's real
 * screen, mouse, or clipboard. Everything the agent sees and drives lives on
 * a virtual display; the real screen is a separate, explicit opt-in.
 *
 * - `ORCHESTRA_DESKTOP_CAPTURE=on` means ONLY "the virtual display is
 *   allowed". It never authorizes the real screen.
 * - The real screen needs `ORCHESTRA_DESKTOP_REAL_SCREEN=on` AND a
 *   non-empty app allowlist (`ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST`) AND
 *   a future expiry (`ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL`, ISO date).
 *   Any of the three missing, expired, or not naming the app → denied.
 * - A denied action fails with a plain-language error. It is never run
 *   "somehow" on the real screen as a fallback.
 * - Rollback is a deny: remove the opt-in and every real-screen path
 *   (desktop_action/inspect, playtest real input, zen_browser, MCP
 *   agent-desktop/playwright, shell screen escapes) refuses.
 *
 * This module depends only on Node built-ins, so every surface (tools, MCP,
 * shell) can import it without a layer cycle. All functions take an explicit
 * env mapping (defaulting to `process.env`) so tests can pass a fake env.
 */

export const VIRTUAL_DISPLAY_DEFAULT = ":99"
export const VIRTUAL_DISPLAY_WIDTH = 1280
export const VIRTUAL_DISPLAY_HEIGHT = 800

export const DESKTOP_OFF_MESSAGE =
  "Desktop access is off by default. Set ORCHESTRA_DESKTOP_CAPTURE=on to allow it."

/** The virtual display only — never the operator's real screen. */
export function isDesktopCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.ORCHESTRA_DESKTOP_CAPTURE?.trim().toLowerCase()
  return value === "on" || value === "1" || value === "true" || value === "enabled" || value === "yes"
}

/** The virtual display the agent works on (`:99` unless overridden). */
export function virtualDisplay(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.ORCHESTRA_VIRTUAL_DISPLAY?.trim() ?? ""
  if (/^:\d+(\.\d+)?$/.test(raw)) return raw
  return VIRTUAL_DISPLAY_DEFAULT
}

/** The operator's own display, for diagnostics only. Never a target. */
export function hostDisplay(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const display = env.DISPLAY?.trim()
  return display ? display : undefined
}

/** Environment override that pins a spawned child process to the virtual display. */
export function agentDisplayEnv(env: NodeJS.ProcessEnv = process.env): { DISPLAY: string } {
  return { DISPLAY: virtualDisplay(env) }
}

export function realScreenAllowlist(env: NodeJS.ProcessEnv = process.env): ReadonlyArray<string> {
  return (env.ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

export function realScreenUntil(env: NodeJS.ProcessEnv = process.env): Date | undefined {
  const raw = env.ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL?.trim()
  if (!raw) return undefined
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

const basename = (target: string): string => {
  const parts = target.replace(/\\/g, "/").split("/").filter(Boolean)
  const last = parts.at(-1) ?? target
  return last.replace(/\.(exe|app)$/i, "")
}

const allowsApp = (allowlist: ReadonlyArray<string>, target: string): boolean => {
  const wanted = target.trim().toLowerCase()
  if (!wanted) return false
  return allowlist.some((entry) => entry === wanted || entry === basename(wanted))
}

export interface RealScreenDecision {
  readonly allowed: boolean
  /** Plain-language reason; set exactly when the action is denied. */
  readonly reason?: string
}

/**
 * Whether one real-screen action may run. `target` is the app the action
 * would touch (window title, app name, or server id); when it is given, the
 * allowlist must name that app.
 */
export function realScreenDecision(
  env: NodeJS.ProcessEnv = process.env,
  target?: string,
  now = Date.now(),
): RealScreenDecision {
  if (!isDesktopCaptureEnabled(env)) return { allowed: false, reason: DESKTOP_OFF_MESSAGE }
  if (env.ORCHESTRA_DESKTOP_REAL_SCREEN?.trim().toLowerCase() !== "on")
    return {
      allowed: false,
      reason:
        "Real-screen access is off by default. The virtual display is the only screen agents may use. " +
        "To allow the real screen explicitly, set ORCHESTRA_DESKTOP_REAL_SCREEN=on together with " +
        "ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST (comma-separated app names) and " +
        "ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL (an ISO date when the permission expires).",
    }
  const allowlist = realScreenAllowlist(env)
  if (allowlist.length === 0)
    return {
      allowed: false,
      reason:
        "Real-screen access is on, but ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST is empty: no app is allowed on the real screen. " +
        "Add the app name to the allowlist (comma-separated).",
    }
  const until = realScreenUntil(env)
  if (until === undefined)
    return {
      allowed: false,
      reason:
        "Real-screen access needs an expiry: set ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL to an ISO date " +
        "(for example 2026-11-07T00:00:00+04:00). Without an expiry the real screen stays closed.",
    }
  if (until.getTime() <= now)
    return {
      allowed: false,
      reason: `Real-screen access expired at ${until.toISOString()}. Set a new ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL to allow it again.`,
    }
  if (target !== undefined && target.trim() !== "" && !allowsApp(allowlist, target))
    return {
      allowed: false,
      reason:
        `"${target}" is not in ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST (${allowlist.join(", ")}). ` +
        "Only allowlisted apps may be touched on the real screen.",
    }
  return { allowed: true }
}

export function isRealScreenAllowed(env: NodeJS.ProcessEnv = process.env, target?: string, now = Date.now()): boolean {
  return realScreenDecision(env, target, now).allowed
}

/** The denial message for a real-screen action, or undefined when it may run. */
export function realScreenDenial(
  env: NodeJS.ProcessEnv = process.env,
  target?: string,
  now = Date.now(),
): string | undefined {
  return realScreenDecision(env, target, now).reason
}

/**
 * Whether the desktop tools may run on this OS at all (G2-9). Linux has
 * the agent's virtual display (Xvfb `:99`); macOS and Windows do not — there
 * the desktop tools can only drive the operator's real screen, mouse, and
 * clipboard, so they need the explicit real-screen opt-in (see
 * realScreenDecision). Returns the refusal message, or undefined when the
 * tools may run. An honest refusal, never a silent run on the real screen.
 * `platform` is a parameter (defaulting to `process.platform`) so tests can
 * exercise the macOS/Windows refusal on Linux.
 */
export function desktopPlatformDenial(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "linux") return undefined
  const denial = realScreenDenial(env)
  if (denial === undefined) return undefined
  const os = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform
  return (
    `On ${os} there is no virtual display: the desktop tools can only touch the operator's real screen, ` +
    `mouse, and clipboard, so they refuse to run. ${denial}`
  )
}

/** The X11 socket a display listens on (`:99` → `/tmp/.X11-unix/X99`). */
export function virtualDisplaySocket(display: string): string | undefined {
  const match = /^:(\d+)(?:\.\d+)?$/.exec(display.trim())
  if (!match) return undefined
  return `/tmp/.X11-unix/X${match[1]}`
}

/** Whether the virtual display is up right now (its socket exists). */
export function isVirtualDisplayAlive(
  display: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const socket = virtualDisplaySocket(display)
  if (socket === undefined) return false
  return exists(socket)
}

/** The command that starts the virtual display. Kept pure so tests can assert it without spawning. */
export function xvfbCommand(display: string): { command: string; args: ReadonlyArray<string> } {
  return {
    command: "Xvfb",
    args: [display, "-screen", "0", `${VIRTUAL_DISPLAY_WIDTH}x${VIRTUAL_DISPLAY_HEIGHT}x24`, "-nolisten", "tcp"],
  }
}

const startedDisplays = new Map<string, ChildProcess>()

export interface VirtualDisplayStatus {
  readonly display: string
  /** True when this call started the display; false when it was already up. */
  readonly started: boolean
  readonly pid?: number
}

/**
 * Make sure the virtual display is up, starting Xvfb when it is not.
 * Throws a plain Error when Xvfb is missing or the display does not come up:
 * the caller turns that into a ToolFailure, never into a screenshot of the
 * real screen.
 */
export async function ensureVirtualDisplay(
  display: string,
  waitMs = 5_000,
  spawnFn: (command: string, args: ReadonlyArray<string>) => ChildProcess = (command, args) =>
    spawn(command, [...args], { detached: true, stdio: "ignore" }),
): Promise<VirtualDisplayStatus> {
  if (isVirtualDisplayAlive(display)) return { display, started: false, pid: startedDisplays.get(display)?.pid }
  const { command, args } = xvfbCommand(display)
  let child: ChildProcess
  try {
    child = spawnFn(command, args)
  } catch (error) {
    throw new Error(
      `Virtual display ${display} is not running and Xvfb could not be started (${error instanceof Error ? error.message : String(error)}). ` +
        "Install Xvfb to let agents work on their own screen; the real screen stays closed.",
    )
  }
  child.unref?.()
  startedDisplays.set(display, child)
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (isVirtualDisplayAlive(display)) return { display, started: true, pid: child.pid }
    if (child.exitCode !== null)
      throw new Error(
        `Virtual display ${display} did not come up: Xvfb exited with code ${child.exitCode}. The real screen stays closed.`,
      )
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `Virtual display ${display} did not come up within ${waitMs} ms. The real screen stays closed.`,
  )
}

/** Stop a display this process started (tests and shutdown only; the shared display normally stays up). */
export function stopVirtualDisplay(display: string): void {
  const child = startedDisplays.get(display)
  if (child) {
    try {
      child.kill()
    } catch {}
    startedDisplays.delete(display)
  }
}

// Shell escapes to the real screen: commands that screenshot, move the
// operator's mouse, or read/write the operator's clipboard straight from the
// shell, bypassing the desktop tools and their virtual display. Each pattern
// names a concrete program or API; a plain `ls` or `git status` never matches.
const DESKTOP_ESCAPE_PATTERNS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\bxdotool\b/i, what: "xdotool (moves the operator's real mouse and keyboard)" },
  { pattern: /\bydotool\b/i, what: "ydotool (moves the operator's real mouse and keyboard)" },
  { pattern: /\bwtype\b/i, what: "wtype (types with the operator's real keyboard on Wayland)" },
  { pattern: /\bscreencapture\b/i, what: "screencapture (screenshots the operator's real screen)" },
  { pattern: /\bgrim\b/i, what: "grim (screenshots a screen outside the virtual display)" },
  { pattern: /\bscrot\b/i, what: "scrot (screenshots a screen outside the virtual display)" },
  { pattern: /\bxwd\b/i, what: "xwd (dumps a window from the operator's screen)" },
  { pattern: /\bimport\b[^|;&]*-window\b/i, what: "ImageMagick import -window (captures a window from the operator's screen)" },
  // A bare `import` (no -window) captures the whole screen. Only a command
  // starting a segment counts: `python -c "import os"` is a Python import,
  // not ImageMagick, and must keep working.
  { pattern: /(^|[|;&]\s*)(sudo\s+)?import\s/i, what: "ImageMagick import (screenshots the operator's whole screen)" },
  { pattern: /\bmagick\s+import\b/i, what: "ImageMagick import (screenshots the operator's whole screen)" },
  { pattern: /\bgnome-screenshot\b/i, what: "gnome-screenshot (screenshots the operator's real screen)" },
  { pattern: /\bflameshot\b/i, what: "flameshot (screenshots the operator's real screen)" },
  { pattern: /\bspectacle\b/i, what: "spectacle (screenshots the operator's real screen)" },
  { pattern: /\bxclip\b/i, what: "xclip (reads or writes the operator's clipboard)" },
  { pattern: /\bxsel\b/i, what: "xsel (reads or writes the operator's clipboard)" },
  { pattern: /\bwl-copy\b/i, what: "wl-copy (writes the operator's clipboard)" },
  { pattern: /\bwl-paste\b/i, what: "wl-paste (reads the operator's clipboard)" },
  { pattern: /\bpbcopy\b/i, what: "pbcopy (writes the operator's clipboard)" },
  { pattern: /\bpbpaste\b/i, what: "pbpaste (reads the operator's clipboard)" },
  // G2-9: macOS GUI control. osascript drives System Events (clicks, keys,
  // screenshots); cliclick is the click helper the desktop tool itself
  // used to need on macOS. Both reach the real screen, never a virtual one.
  { pattern: /\bosascript\b/i, what: "osascript (drives the operator's real screen, mouse, and keyboard through macOS System Events)" },
  { pattern: /\bcliclick\b/i, what: "cliclick (clicks with the operator's real mouse on macOS)" },
  // G2-9: scripted GUI automation libraries. The program name in the command
  // is what the gate sees: `python -c "import pyautogui; ..."` is caught,
  // a script file that imports it inside is not — the blacklist is a trip
  // wire, not a sandbox (see the note on forbiddenDesktopEscape).
  { pattern: /\bpyautogui\b/i, what: "pyautogui (moves the operator's real mouse and keyboard from Python)" },
  { pattern: /\bpynput\b/i, what: "pynput (moves the operator's real mouse and keyboard from Python)" },
  { pattern: /\bpywinauto\b/i, what: "pywinauto (drives the operator's real screen from Python on Windows)" },
  // G2-9: X window tools that read or drive the real screen's window tree.
  { pattern: /\bxprop\b/i, what: "xprop (reads windows from the operator's screen)" },
  { pattern: /\bxwininfo\b/i, what: "xwininfo (reads windows from the operator's screen)" },
  { pattern: /\bwmctrl\b/i, what: "wmctrl (moves and focuses windows on the operator's screen)" },
  // G2-9: Android Debug Bridge drives a real attached device's screen and input.
  { pattern: /\badb\b/i, what: "adb (drives a real Android device's screen and input)" },
  { pattern: /CopyFromScreen/i, what: "CopyFromScreen (screenshots the operator's real screen from PowerShell)" },
  { pattern: /SendKeys/i, what: "SendKeys (types into the operator's focused window from PowerShell)" },
  { pattern: /SetCursorPos/i, what: "SetCursorPos (moves the operator's real mouse from PowerShell)" },
  { pattern: /mouse_event/i, what: "mouse_event (clicks with the operator's real mouse from PowerShell)" },
  { pattern: /keybd_event/i, what: "keybd_event (types with the operator's real keyboard from PowerShell)" },
  { pattern: /\[System\.Windows\.Forms\.Clipboard\]/i, what: "Windows Clipboard (reads or writes the operator's clipboard from PowerShell)" },
]

/**
 * A shell command that would reach the operator's real screen, mouse, or
 * clipboard. Returns the refusal message, or undefined when the command is
 * clean — or when the real-screen opt-in is valid, in which case the operator
 * explicitly allowed it. `DISPLAY=:99` (the virtual display) is fine; any
 * other explicit display is an escape.
 *
 * This is a pattern blacklist over the command text, not a sandbox: a
 * command built at runtime (`eval`, a quoted `bash -c`, a script file that
 * imports a GUI library inside) can hide from it. The desktop tools and the
 * MCP real-screen servers are gated separately, so the blacklist is a trip
 * wire on the shell path, not the only fence.
 */
export function forbiddenDesktopEscape(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const { pattern, what } of DESKTOP_ESCAPE_PATTERNS) {
    if (pattern.test(command))
      return realScreenAllowedMessage(env, `Refusing to run a shell command that uses ${what}. Use the desktop_* tools instead: they work on the agent's virtual display and never touch your screen, mouse, or clipboard.`)
  }
  const displayMatch = /DISPLAY\s*=\s*(:\d+(?:\.\d+)?|\$[A-Za-z_][A-Za-z0-9_]*)/.exec(command)
  if (displayMatch) {
    const wanted = displayMatch[1] ?? ""
    if (wanted !== virtualDisplay(env))
      return realScreenAllowedMessage(
        env,
        `Refusing to run a shell command that targets display ${wanted} instead of the agent's virtual display ${virtualDisplay(env)}. The operator's screen is not available to agents.`,
      )
  }
  return undefined
}

const realScreenAllowedMessage = (env: NodeJS.ProcessEnv, refusal: string): string | undefined => {
  if (isRealScreenAllowed(env)) return undefined
  return `${refusal} ${realScreenDecision(env).reason ?? ""}`.trim()
}
