export * as BrowserProvenance from "./provenance.js"

import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from "node:fs"
import path from "node:path"
import { Global } from "@orchestra/util/global"

export type Record =
  | { mode: "ordinary" }
  | { mode: "read-only"; triggerID: string; browserSessionID?: string }
export type State = Record | { mode: "unknown" }
const file = (id: string) => path.join(Global.Path.data, "browser-provenance", `${encodeURIComponent(id)}.json`)

const marker = (id: string) => path.join(Global.Path.data, "browser-trigger-bound", `${encodeURIComponent(id)}.bound`)
/** A separate durable marker distinguishes untouched interactive chats from lost task state.
 * Never remove it on reset: later loss of the ordinary record must still fail closed. */
export function bind(sessionID: string): boolean {
  try {
    mkdirSync(path.dirname(marker(sessionID)), { recursive: true })
    writeFileSync(marker(sessionID), "trigger-bound\n", { mode: 0o600 })
    return true
  } catch { return false }
}
function missingState(sessionID: string): State {
  try { statSync(marker(sessionID)); return { mode: "unknown" } }
  catch (error) {
    // Only a proven absent marker permits the original interactive behavior.
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? { mode: "ordinary" } : { mode: "unknown" }
  }
}
/** Untouched interactive chats stay ordinary. Bound chats fail closed on loss/corruption. */
export function read(sessionID: string): State {
  try {
    const value: unknown = JSON.parse(readFileSync(file(sessionID), "utf8"))
    if (!value || typeof value !== "object") return { mode: "unknown" }
    const v = value as { mode?: unknown; triggerID?: unknown; browserSessionID?: unknown }
    if (v.mode === "ordinary") return { mode: "ordinary" }
    if (v.mode !== "read-only" || typeof v.triggerID !== "string" || !v.triggerID) return { mode: "unknown" }
    if (v.browserSessionID !== undefined && (typeof v.browserSessionID !== "string" || !v.browserSessionID)) return { mode: "unknown" }
    return { mode: "read-only", triggerID: v.triggerID, ...(typeof v.browserSessionID === "string" ? { browserSessionID: v.browserSessionID } : {}) }
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? missingState(sessionID) : { mode: "unknown" }
  }
}

/** Must succeed before dispatch. An old record is never used as fallback authority. */
export function write(sessionID: string, record: Record): boolean {
  try {
    if (record.mode === "read-only" && !bind(sessionID)) return false
    const target = file(sessionID)
    mkdirSync(path.dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
    renameSync(temp, target)
    return true
  } catch { return false }
}

const reads = new Set(["text", "snapshot", "screenshot", "info"])
export function refusal(state: State, action: string, target?: string) {
  if (state.mode === "ordinary") return undefined
  if (!reads.has(action)) return "Browser task authority is read-only or unavailable. Only text, snapshot, screenshot and info are allowed. Request a new operator dispatch before changing a page."
  if (state.mode === "read-only" && state.browserSessionID && target !== undefined && target !== state.browserSessionID)
    return "This scheduled task may read only its bound browser session."
  return undefined
}


/** Only the ordinary operator-dispatch path calls this; no browser action exposes it. */
export const reset = (sessionID: string) => write(sessionID, { mode: "ordinary" })
