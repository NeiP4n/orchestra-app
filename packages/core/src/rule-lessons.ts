export * as RuleLessons from "./rule-lessons.js"

import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { KV } from "./kv.js"
import type { Entry } from "./rule-enforce.js"

export const CAP = 3
const LIMIT = 500
const KEY = "rule-lessons/"
type Row = { fingerprint: string; count: number }
type Pending = { project: string; rows: Row[] }
const sessions = new Map<string, Pending>()
const fingerprint = (entry: Entry) => createHash("sha256").update(`${entry.title}\0${entry.text}\0${entry.by}`).digest("hex")
const rowsOf = (value: unknown): Row[] => !Array.isArray(value) ? [] : value.filter((row): row is Row =>
  !!row && typeof row === "object" && typeof row.fingerprint === "string" && /^[a-f0-9]{64}$/.test(row.fingerprint) && Number.isInteger(row.count) && row.count >= 1 && row.count <= 2,
).slice(-CAP)
const merge = (rows: Row[], row: Row): Row[] => {
  const prior = rows.find(item => item.fingerprint === row.fingerprint)
  return [...rows.filter(item => item.fingerprint !== row.fingerprint), { fingerprint: row.fingerprint, count: Math.min(2, (prior?.count ?? 0) + row.count) }].slice(-CAP)
}

/** Only rule identities are retained: never call input, page text, judge prose, or transcripts. */
export const record = (sessionID: string, entry: Entry) => {
  const pending = sessions.get(sessionID)
  if (pending) pending.rows = merge(pending.rows, { fingerprint: fingerprint(entry), count: 1 })
}

/** Request-time project binding comes from the successful rule scope lookup, never a log file. */
export const refresh = (kv: KV.Interface, project: string | undefined, sessionID: string, entries: readonly Entry[], enabled = true) =>
  Effect.gen(function* () {
    const pending = sessions.get(sessionID)
    sessions.delete(sessionID)
    if (!project || !enabled) return ""
    sessions.set(sessionID, { project, rows: [] })
    if (sessions.size > LIMIT) sessions.delete(sessions.keys().next().value!)
    const updates = pending?.project === project ? pending.rows : []
    const key = KEY + project
    const value = updates.length
      ? yield* kv.atomicUpdate(key, current => updates.reduce(merge, rowsOf(current)))
      : yield* kv.get(key)
    const rows = rowsOf(value)
    const learned = entries.filter(entry => entry.text.length <= 240 && entry.title.length <= 64).filter((entry, index) => entries.findIndex(other => fingerprint(other) === fingerprint(entry)) === index)
      .filter(entry => rows.some(row => row.count >= 2 && row.fingerprint === fingerprint(entry))).slice(0, CAP)
    if (!learned.length) return ""
    return [
      "# Rule lessons",
      "Reminders from repeated refused calls or judged violations, not new rules or permission. Current rules and permissions always win. Before acting, check the cited rule; do not retry the same blocked approach. Choose an allowed method, or report the blocker without bypassing the rule.",
      ...learned.map(entry => `- [${entry.title}] Re-check before acting: ${entry.text}`),
    ].join("\n")
  })

export const forgetProject = (kv: KV.Interface, project: string) => Effect.gen(function* () {
  for (const [session, value] of sessions) if (value.project === project) sessions.delete(session)
  yield* kv.remove(KEY + project)
})
