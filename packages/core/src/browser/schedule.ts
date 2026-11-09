export * as BrowserSchedule from "./schedule.js"

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import { Global } from "@orchestra/util/global"

// Operational status only. No page text, titles, URLs or private messages are stored.
export interface Status {
  triggerID: string
  browserSessionID: string
  watcher?: "off" | "failed" | "watching"
  lastEventAt?: number
  localTest?: boolean
  enabled: boolean
  nextAt: number | null
  phase: "waiting" | "dispatched" | "checking" | "checked" | "info" | "error" | "paused"
  lastDispatchAt?: number
  lastInfoAt?: number
  lastCheckedAt?: number
  error?: string
}
const file = (id: string) => path.join(Global.Path.data, "browser-schedules", `${encodeURIComponent(id)}.json`)

// A denied write cannot be persisted to the same denied folder. Keep a local
// error overlay for reporting and fail closed; never turn a failed save green.
const ioErrors = new Map<string, Status>()
const phases = new Set(["waiting", "dispatched", "checking", "checked", "info", "error", "paused"])
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
export function get(id: string): Status | undefined {
  const error = ioErrors.get(file(id))
  if (error) return error
  try {
    const v = JSON.parse(readFileSync(file(id), "utf8")) as Status
    if (!v || v.triggerID !== id || typeof v.browserSessionID !== "string" || typeof v.enabled !== "boolean" ||
      !phases.has(v.phase) || !(v.nextAt === null || finite(v.nextAt)) ||
      (v.lastInfoAt !== undefined && !finite(v.lastInfoAt)) ||
      (v.lastCheckedAt !== undefined && !finite(v.lastCheckedAt)) ||
      (v.lastDispatchAt !== undefined && !finite(v.lastDispatchAt))) return undefined
    return v
  } catch { return undefined }
}
export function save(status: Status): boolean {
  const target = file(status.triggerID)
  const previous = get(status.triggerID)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(tmp, JSON.stringify(status))
    renameSync(tmp, target)
    ioErrors.delete(target)
    return true
  } catch {
    ioErrors.set(target, { ...status, enabled: false, nextAt: null, phase: "error",
      lastCheckedAt: previous?.lastCheckedAt,
      error: "Schedule status storage is unavailable. No new successful check was recorded." })
    try { rmSync(tmp, { force: true }) } catch {}
    return false
  }
}
export function remove(id: string): boolean {
  const previous = get(id)
  try {
    rmSync(file(id), { force: true })
    ioErrors.delete(file(id))
    return true
  } catch {
    if (previous) ioErrors.set(file(id), { ...previous, enabled: false, nextAt: null, phase: "error",
      error: "Schedule status could not be removed. Page checks are blocked in this process." })
    return false
  }
}

export function sync(trigger: { id: string; browserSessionID?: string; localTest?: boolean; enabled: boolean; nextAt: number | null }) {
  if (!trigger.browserSessionID) return
  const previous = get(trigger.id)
  save({ ...previous, triggerID: trigger.id, browserSessionID: trigger.browserSessionID, localTest: trigger.localTest,
    enabled: trigger.enabled, nextAt: trigger.enabled ? trigger.nextAt : null,
    phase: trigger.enabled ? previous?.phase === "paused" ? "waiting" : previous?.phase ?? "waiting" : "paused" })
}
export function dispatched(id: string, now: number) {
  const previous = get(id)
  if (previous) save({ ...previous, phase: "dispatched", lastDispatchAt: now, error: undefined })
}
export function started(id: string, sessionID: string) {
  const previous = get(id)
  if (!previous?.enabled || previous.browserSessionID !== sessionID) return
  save({ ...previous, phase: "checking", error: undefined })
}
export function finished(id: string, sessionID: string, ok: boolean, now = Date.now()) {
  const previous = get(id)
  if (!previous?.enabled || previous.browserSessionID !== sessionID) return
  save({ ...previous, phase: ok ? "checked" : "error",
    ...(ok ? { lastCheckedAt: now, error: undefined } : { error: "Page read failed. No successful check recorded." }) })
}
export function deliveryFailed(id: string) {
  const previous = get(id)
  if (previous) save({ ...previous, phase: "error", error: "Could not deliver the check to the Orchestrator." })
}


/** Only this session's operational status, never another session's page content. */
export function forSession(sessionID: string): Status[] {
  const found = new Map<string, Status>()
  const directory = path.join(Global.Path.data, "browser-schedules")
  try {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue
      let id: string
      try { id = decodeURIComponent(name.slice(0, -5)) } catch { continue }
      const status = get(id)
      if (status?.browserSessionID === sessionID) found.set(id, status)
    }
  } catch {}
  for (const [target, status] of ioErrors)
    if (path.dirname(target) === directory && status.browserSessionID === sessionID) found.set(status.triggerID, status)
  return [...found.values()]
}


/** Title/URL inspection is an update, not evidence that page content was read. */
export function inspected(id: string, sessionID: string, now = Date.now()) {
  const previous = get(id)
  if (!previous?.enabled || previous.browserSessionID !== sessionID) return
  save({ ...previous, phase: "info", lastInfoAt: now, error: undefined })
}


/** Watching proves installation on a live connection, not that every DOM row is detectable. */
export function watchStatus(id: string, watching: boolean, lastEventAt?: number) {
  const previous = get(id)
  if (!previous) return
  save({ ...previous, watcher: !previous.enabled ? "off" : watching ? "watching" : "failed",
    ...(lastEventAt === undefined ? {} : { lastEventAt }) })
}
