export * as ProjectWork from "./project-work.js"
import { Effect, Option, Schema } from "effect"
import { Orchestra } from "@orchestra/schema/orchestra"
import { Federation } from "@orchestra/schema/federation"
import type { KV } from "../kv.js"
import type { SessionStore } from "./store.js"
import { SessionID } from "@orchestra/schema/session-id"
const decode = Schema.decodeUnknownOption(Orchestra.Project)
/** Same explicit owner/main/lineage precedence as Orchestra. Never conflate shared directories. */
export const owner = (kv: KV.Interface, store: SessionStore.Interface, sessionID: string) => Effect.gen(function* () {
  const projects: Orchestra.Project[] = []
  let after: string | undefined
  do {
    const page = yield* kv.scan({ prefix: "orchestra/project/", after, limit: 1000 })
    for (const entry of page.entries) { const p = decode(entry.value); if (Option.isSome(p)) projects.push(p.value) }
    after = page.next
  } while (after)
  const seen = new Set<string>()
  let session = yield* store.get(SessionID.make(sessionID))
  const original = session
  while (session && !seen.has(session.id)) {
    seen.add(session.id)
    const claim = yield* kv.get("orchestra/owner/" + session.id)
    const explicit = typeof claim === "string" ? claim : Orchestra.sessionOwner(session.metadata)
    if (explicit) return projects.find(p => p.id === explicit)
    if (Federation.groupSupervisor(session.metadata) !== undefined) return undefined
    const main = projects.find(p => p.main === session!.id)
    if (main) return main
    if (!session.parentID) break
    session = yield* store.get(session.parentID)
  }
  return original ? Orchestra.ownerOf(projects, original.location.directory) : undefined
})
export const held = (kv: KV.Interface, store: SessionStore.Interface, sessionID: string) =>
  owner(kv, store, sessionID).pipe(Effect.map(project => project?.workEnabled === false))
