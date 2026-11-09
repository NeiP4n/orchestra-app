export * as ScheduleView from "./schedule-view.js"

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import { Global } from "@orchestra/util/global"
import type { Trigger } from "./trigger.js"

// Read-only local UI projection. KV remains the scheduler's source of truth.
export interface Item {
  id: string
  sessionID: string
  name: string
  total?: number
  localActions?: boolean
  actionErrors?: number
  kind: Trigger.Kind
  enabled: boolean
  nextAt: number | null
  lastFiredAt?: number
  pausedReason?: string
  browserSessionID?: string
  updatedAt: number
}
const directory = () => path.join(Global.Path.data, "schedule-view")
const file = (id: string) => path.join(directory(), `${encodeURIComponent(id)}.json`)
export function shortName(prompt: string): string {
  const text = prompt.replace(/\s+/g, " ").trim()
  if (text.length <= 80) return text
  const prefix = text.slice(0, 79)
  if (/\s/.test(text[79] ?? "")) return `${prefix.trimEnd()}…`
  const boundary = prefix.lastIndexOf(" ")
  return boundary > 0 ? `${prefix.slice(0, boundary)}…` : "…"
}
export function sync(trigger: Trigger.Info, sessionID: string) {
  try {
    const item: Item = { id: trigger.id, sessionID, name: shortName(trigger.prompt), kind: trigger.kind,
      total: trigger.total, localActions: !!trigger.actions?.length, actionErrors: trigger.errors?.consecutive,
      enabled: trigger.enabled, nextAt: trigger.enabled ? trigger.nextAt : null, lastFiredAt: trigger.lastFiredAt,
      pausedReason: trigger.pausedReason, browserSessionID: trigger.browserSessionID, updatedAt: Date.now() }
    mkdirSync(directory(), { recursive: true })
    const temporary = `${file(trigger.id)}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(item))
    renameSync(temporary, file(trigger.id))
    return true
  } catch { return false }
}
export function remove(id: string) {
  try { rmSync(file(id), { force: true }); return true } catch { return false }
}
export function list(sessionID: string): Item[] {
  try {
    return readdirSync(directory()).flatMap((name) => {
      if (!name.endsWith(".json")) return []
      try {
        const v = JSON.parse(readFileSync(path.join(directory(), name), "utf8")) as Item
        if (v.sessionID !== sessionID || typeof v.id !== "string" || typeof v.name !== "string" ||
          !["cron", "interval", "once", "browser", "internal"].includes(v.kind) || typeof v.enabled !== "boolean" ||
          !(v.nextAt === null || Number.isFinite(v.nextAt)) || !Number.isFinite(v.updatedAt)) return []
        return [v]
      } catch { return [] }
    }).sort((a, b) => a.id.localeCompare(b.id))
  } catch { return [] }
}

const removalFile = (id: string) => path.join(directory(), `${encodeURIComponent(id)}.remove.json`)
/** Operator sidebar request, not a model action. Scheduler validates exact owning main before deletion. */
export function requestRemoval(id: string, sessionID: string) {
  const item = list(sessionID).find((item) => item.id === id)
  if (!item) throw new Error("Расписание не найдено в этом чате.")
  const tmp = `${removalFile(id)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ id, sessionID }))
  renameSync(tmp, removalFile(id))
}
export function removalRequested(id: string, sessionID: string): boolean {
  try { const v = JSON.parse(readFileSync(removalFile(id), "utf8")); return v.id === id && v.sessionID === sessionID } catch { return false }
}
export function clearRemoval(id: string) { try { rmSync(removalFile(id), { force: true }) } catch {} }
