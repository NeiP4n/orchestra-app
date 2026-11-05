export * as McpReaper from "./reaper.js"

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@orchestra/util/global"

// An MCP server is usually a launcher chain (`cmd` -> `npx` -> `node` -> a Python child), and on Windows there is
// no process group: killing the process Orchestra spawned leaves the rest of the chain running. Every restart of
// the service then leaves a full set of servers behind, and a few restarts exhaust the machine's memory. So the
// whole tree is killed on close, and the servers of a service that died without closing are found again by the
// next one through a small registry of what was started.
interface Entry {
  readonly pid: number
  /** The service process that started it; a live owner keeps its servers. */
  readonly owner: number
  readonly server: string
  /** The first token of the launch command, to tell the process from a later one that reused the pid. */
  readonly command: string
}

const file = () => path.join(Global.Path.state, "mcp-children.json")

const isEntry = (value: unknown): value is Entry =>
  typeof value === "object" &&
  value !== null &&
  Number.isInteger((value as Entry).pid) &&
  Number.isInteger((value as Entry).owner) &&
  typeof (value as Entry).server === "string" &&
  typeof (value as Entry).command === "string"

const read = (): Entry[] => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file(), "utf8"))
    return Array.isArray(parsed) ? parsed.filter(isEntry) : []
  } catch {
    return []
  }
}

// The registry is read by the next service to decide what to kill, so a half-written
// file is worse than a missing one: write to a temp file in the same directory and
// rename it over the registry, so readers only ever see the old file or the new one.
const write = (entries: readonly Entry[]) => {
  try {
    const target = file()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = path.join(path.dirname(target), `.mcp-children.json.${process.pid}.tmp`)
    const fd = fs.openSync(temporary, "w")
    try {
      fs.writeFileSync(fd, JSON.stringify(entries))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, target)
  } catch {
    // The registry only helps the next start; losing it must never break a running server.
  }
}

/** The process's command line, or undefined when it is gone or cannot be read. */
const commandLineOf = (pid: number): string | undefined => {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")
    if (cmdline.length > 0) return cmdline.replaceAll("\0", " ").trim()
  } catch {
    // No /proc (macOS): fall through to ps.
  }
  try {
    const listed = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    })
    const line = String(listed.stdout ?? "").trim()
    return line.length > 0 ? line : undefined
  } catch {
    return undefined
  }
}

/**
 * Kills a process and everything it started. When the expected launch command is given,
 * the process is only killed when its command line still names that command: a pid the
 * OS reused for an unrelated program must never be killed because the registry is stale.
 * A process whose command line cannot be read is left alone — failing closed is safer
 * than killing a stranger.
 */
export const killTree = (pid: number, expectedCommand?: string) => {
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", (error) => console.warn("[mcp-reaper] taskkill failed", { pid, error }))
      .unref()
    return
  }
  if (expectedCommand !== undefined) {
    const commandLine = commandLineOf(pid)
    if (commandLine === undefined || !commandLine.includes(path.basename(expectedCommand))) return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch (error) {
    // The process group is already gone (or never existed): fall back to the single pid, and
    // say so instead of swallowing the failure — a reaper that silently misses its target
    // leaves the whole MCP server chain running (taxonomy C3).
    console.warn("[mcp-reaper] process group kill failed, retrying single pid", { pid, error })
    try {
      process.kill(pid, "SIGKILL")
    } catch (retryError) {
      console.warn("[mcp-reaper] process kill failed; the process is already gone or unkillable", {
        pid,
        error: retryError,
      })
    }
  }
}

export const track = (entry: Omit<Entry, "owner">) => write([...read().filter((item) => item.pid !== entry.pid), { ...entry, owner: process.pid }])

export const untrack = (pid: number) => write(read().filter((item) => item.pid !== pid))

const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

let reaped = false

/** Kills the servers a previous service left running. Runs once per process, before the first server starts. */
export const reap = () => {
  if (reaped) return
  reaped = true
  const all = read()
  const entries = all.filter((entry) => entry.owner !== process.pid && !running(entry.owner))
  if (entries.length === 0) return
  write(all.filter((entry) => !entries.includes(entry)))
  if (process.platform !== "win32") {
    entries.forEach((entry) => killTree(entry.pid, entry.command))
    return
  }
  // A pid can be reused by an unrelated program, so only a process whose command line still names the
  // server's command is killed.
  const script = `Get-CimInstance Win32_Process -Filter "${entries.map((entry) => `ProcessId=${Math.trunc(entry.pid)}`).join(" OR ")}" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
  const listed = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  })
  const alive = new Map(
    String(listed.stdout ?? "")
      .split(/\r?\n/)
      .flatMap((line) => {
        const at = line.indexOf("|")
        return at > 0 ? [[Number(line.slice(0, at)), line.slice(at + 1)] as const] : []
      }),
  )
  entries.forEach((entry) => {
    const commandLine = alive.get(entry.pid)
    if (commandLine !== undefined && commandLine.toLowerCase().includes(path.basename(entry.command).toLowerCase()))
      killTree(entry.pid)
  })
}
