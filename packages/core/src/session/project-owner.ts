export * as SessionProjectOwner from "./project-owner.js"

import { Effect, Option, Schema } from "effect"
import { Orchestra } from "@orchestra/schema/orchestra"
import type { KV } from "../kv.js"

const decode = Schema.decodeUnknownOption(Orchestra.Project)
/** Passive canonical ownership lookup. Directory proximity is never a grant. No repair, main creation,
 * transcript reads or roster reconciliation. Conflicting persisted bindings fail closed. */
export const resolve = Effect.fn("SessionProjectOwner.resolve")(function* (
  kv: Pick<KV.Interface, "get" | "scan">,
  session: { id: string; metadata?: Parameters<typeof Orchestra.sessionOwner>[0] },
) {
  const marker = yield* kv.get("orchestra/owner/" + session.id)
  const metadata = Orchestra.sessionOwner(session.metadata)
  if (marker !== undefined && (typeof marker !== "string" || !marker)) return undefined
  if (marker !== undefined && metadata !== undefined && marker !== metadata) return undefined
  const claimed = marker ?? metadata
  if (typeof claimed === "string") {
    const project = Option.getOrUndefined(decode(yield* kv.get("orchestra/project/" + claimed)))
    if (!project || project.id !== claimed) return undefined
    if ((yield* kv.get("orchestra/move-plan/" + claimed)) !== undefined) return undefined
    return project.id
  }
  // Legacy main sessions can predate the explicit owner marker. Project.main is an exact stable binding.
  let after: string | undefined
  let found: Orchestra.Project | undefined
  let count = 0
  let pages = 0
  do {
    const page = yield* kv.scan({ prefix: "orchestra/project/", after, limit: 1000 })
    count += page.entries.length
    pages++
    if (count > 10000 || pages > 100 || (page.next !== undefined && page.next === after)) return undefined
    for (const row of page.entries) {
      const project = Option.getOrUndefined(decode(row.value))
      if (project?.main !== session.id) continue
      if (found) return undefined
      found = project
    }
    after = page.next
  } while (after)
  if (!found || (yield* kv.get("orchestra/move-plan/" + found.id)) !== undefined) return undefined
  const current = Option.getOrUndefined(decode(yield* kv.get("orchestra/project/" + found.id)))
  return current?.id === found.id && current.main === session.id ? current.id : undefined
})
