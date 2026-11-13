export * as SessionOrphanCleanup from "./orphan-cleanup.js"

import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { Orchestra } from "@orchestra/schema/orchestra"
import { Federation } from "@orchestra/schema/federation"
import { eq } from "drizzle-orm"
import type { Session } from "../session.js"
import type { KV } from "../kv.js"
import type { SessionExecution } from "./execution.js"
import type { Database } from "../database/database.js"
import type { SessionStore } from "./store.js"
import { SessionInbox } from "./inbox.js"
import { SessionTable } from "./sql.js"

export const DEFINITION = "Only idle, non-archived leaf sessions whose parent no longer exists, with no current project or group ownership. Root chats and browser chats are preserved."
const TTL = 5 * 60 * 1000

/** Backend-only classification. Never infer absence from a paginated or collapsed TUI. */
export function make(input: {
  sessions: Session.Interface; store: SessionStore.Interface; execution: SessionExecution.Interface
  kv: Pick<KV.Interface, "get">; db: Database.Interface["db"]; inbox: Pick<SessionInbox.Interface, "list">
  projects: Effect.Effect<readonly Orchestra.Project[]>
}) {
  const previews = new Map<string, { ids: readonly string[]; current?: string; expires: number }>()
  const candidates = (current?: string) => Effect.gen(function* () {
    const all = yield* input.store.list()
    const projects = yield* input.projects
    const ids = new Set(all.map(session => session.id))
    const parents = new Set(all.flatMap(session => session.parentID ? [session.parentID] : []))
    const active = yield* input.execution.active
    const claimed = new Set(yield* input.store.listSuspended())
    const result: typeof all = []
    for (const session of all) {
      if (!session.parentID || ids.has(session.parentID) || parents.has(session.id) || session.id === current || active.has(session.id) || claimed.has(session.id)) continue
      if (session.time.archived !== undefined || /browser/i.test(session.agent ?? "") || /browser/i.test(session.title ?? "")) continue
      if (Federation.groupSupervisor(session.metadata) !== undefined) continue
      const marker = yield* input.kv.get("orchestra/owner/" + session.id)
      const metadataOwner = Orchestra.sessionOwner(session.metadata)
      // Unknown/corrupt/conflicting owner records are not permission to delete.
      if (marker !== undefined && (typeof marker !== "string" || metadataOwner && marker !== metadataOwner)) continue
      if (projects.some(project => project.main === session.id) || Orchestra.ownerOf(projects, session.location.directory, typeof marker === "string" ? marker : metadataOwner)) continue
      if ((yield* input.inbox.list(session.id)).length) continue
      result.push(session)
    }
    return result
  })
  return {
    prepare: (current?: string) => Effect.gen(function* () {
      for (const [token, preview] of previews) if (preview.expires < Date.now()) previews.delete(token)
      if (previews.size >= 20) throw Error("Too many pending cleanup previews")
      const rows = yield* candidates(current)
      const token = randomUUID()
      previews.set(token, { ids: rows.map(row => row.id), current, expires: Date.now() + TTL })
      return { token, count: rows.length, definition: DEFINITION }
    }),
    confirm: (token: string) => Effect.gen(function* () {
      const preview = previews.get(token)
      previews.delete(token)
      if (!preview || preview.expires < Date.now()) throw Error("Cleanup preview expired. Check the count again.")
      let removed = 0, skipped = 0
      const deleted: Session.ID[] = []
      for (const id of preview.ids) {
        if (!input.execution.whileIdle) { skipped++; continue }
        const result = yield* input.execution.whileIdle(id as Session.ID, SessionInbox.serialized(id as Session.ID, input.db.transaction(() => Effect.gen(function* () {
          const eligible = (yield* candidates(preview.current)).find(row => row.id === id)
          if (!eligible) return false
          // A persisted claim is protected even when owned by another process.
          const row = yield* input.db.select({ claim: SessionTable.time_suspended }).from(SessionTable).where(eq(SessionTable.id, eligible.id)).get().pipe(Effect.orDie)
          if (!row || row.claim !== null) return false
          yield* input.sessions.remove(eligible.id, { recursive: false })
          return true
        }))))
        if (result) { removed++; deleted.push(id as Session.ID) } else skipped++
      }
      return { removed, skipped, deleted }
    }),
  }
}
