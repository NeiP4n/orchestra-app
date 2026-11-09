export * as BrowserSchedule from "./schedule.js"

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import { Global } from "@orchestra/util/global"

// Operational status only. No page text, titles, URLs or private messages are stored.
export interface Status {
  triggerID: string
  browserSessionID: string
  enabled: boolean
  nextAt: number | null
  phase: "waiting" | "dispatched" | "checking" | "checked" | "error" | "paused"
  lastDispatchAt?: number
  lastCheckedAt?: number
  error?: string
}
const file = (id: string) => path.join(Global.Path.data, "browser-schedules", `${encodeURIComponent(id)}.json`)

export function get(id: string): Status | undefined {
  try {
    const v = JSON.parse(readFileSync(file(id), "utf8")) as Status
    if (v.triggerID !== id || typeof v.browserSessionID !== "string" || typeof v.enabled !== "boolean") return undefined
    return v
  } catch { return undefined }
}
export function save(status: Status) {
  const target = file(status.triggerID)
  mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(status))
  renameSync(tmp, target)
}
export function remove(id: string) { rmSync(file(id), { force: true }) }

export function sync(trigger: { id: string; browserSessionID?: string; enabled: boolean; nextAt: number | null }) {
  if (!trigger.browserSessionID) return
  const previous = get(trigger.id)
  save({ ...previous, triggerID: trigger.id, browserSessionID: trigger.browserSessionID,
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
  try {
    return readdirSync(path.join(Global.Path.data, "browser-schedules")).flatMap((name) => {
      if (!name.endsWith(".json")) return []
      let id: string
      try { id = decodeURIComponent(name.slice(0, -5)) } catch { return [] }
      const status = get(id)
      return status?.browserSessionID === sessionID ? [status] : []
    })
  } catch { return [] }
}
