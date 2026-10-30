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

const read = (): Entry[] => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file(), "utf8"))
    return Array.isArray(parsed) ? (parsed as Entry[]) : []
  } catch {
    return []
  }
}

const write = (entries: readonly Entry[]) => {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(entries))
  } catch {
    // The registry only helps the next start; losing it must never break a running server.
  }
}

/** Kills a process and everything it started. */
export const killTree = (pid: number) => {
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {}).unref()
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
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
    entries.forEach((entry) => killTree(entry.pid))
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
