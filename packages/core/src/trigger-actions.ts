export * as TriggerActions from "./trigger-actions.js"

/** Versioned, closed vocabulary. No string-to-function, shell, send or arbitrary JS dispatch. */
export type Action =
  | { kind: "browser.read"; sessionID: string; format: "text" | "snapshot"; timeoutMs: number; maxChars: number }
  | { kind: "orchestra.status" }
  | { kind: "orchestra.log"; message: string }
export const MAX_ACTIONS = 5
export const ERROR_LIMIT = 3
export interface Errors { consecutive: number; total: number; lastAt?: number }
export const emptyErrors = (): Errors => ({ consecutive: 0, total: 0 })
export const recordFailure = (errors: Errors, at: number): Errors => ({ consecutive: errors.consecutive + 1, total: errors.total + 1, lastAt: at })
export const recordSuccess = (errors: Errors): Errors => ({ ...errors, consecutive: 0 })
export const mustPause = (errors: Errors) => errors.consecutive >= ERROR_LIMIT

export function parse(value: unknown): { ok: true; actions: Action[] } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error })
  if (value === undefined) return { ok: true, actions: [] } // Existing wake-only triggers keep their behaviour.
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) return fail(`actions must be an array of at most ${MAX_ACTIONS} allowlisted actions.`)
  const actions: Action[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("Invalid trigger action.")
    const row = entry as Record<string, unknown>
    if (row.kind === "orchestra.status" && Object.keys(row).length === 1) { actions.push({ kind: row.kind }); continue }
    if (row.kind === "orchestra.log") {
      if (Object.keys(row).some((key) => !["kind", "message"].includes(key)) || typeof row.message !== "string" || !row.message.trim() || row.message.length > 500) return fail("orchestra.log needs a fixed operator-authored message of at most 500 characters.")
      actions.push({ kind: row.kind, message: row.message }); continue
    }
    if (row.kind === "browser.read") {
      if (Object.keys(row).some((key) => !["kind", "sessionID", "format", "timeoutMs", "maxChars"].includes(key))) return fail("Unknown browser.read option.")
      if (typeof row.sessionID !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(row.sessionID)) return fail("browser.read needs one exact existing browser session ID.")
      if (row.format !== "text" && row.format !== "snapshot") return fail("browser.read format is text or snapshot only.")
      const timeoutMs = row.timeoutMs ?? 2000
      const maxChars = row.maxChars ?? 3000
      if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 100 || Number(timeoutMs) > 3000 || !Number.isInteger(maxChars) || Number(maxChars) < 1 || Number(maxChars) > 5000) return fail("browser.read limits: 100-3000ms and 1-5000 characters.")
      actions.push({ kind: row.kind, sessionID: row.sessionID, format: row.format, timeoutMs: Number(timeoutMs), maxChars: Number(maxChars) }); continue
    }
    // A model-provided approved:true is not an operator's explicit grant.
    return fail("Action not enabled. Arbitrary JS, agent starts, shell, network, sends and paid execution require a separate safe implementation and operator approval.")
  }
  return { ok: true, actions }
}
