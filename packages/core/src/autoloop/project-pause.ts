import { Effect } from "effect"
import type { KV } from "../kv.js"
import type { View } from "./kernel/evolve.js"
/** Bind only explicit Orchestra task event provenance, never a worker name or shared directory. */
export const pausedProjectRuns = (view: View, kv: KV.Interface) => Effect.gen(function* () {
  const paused = new Set<number>(), cache = new Map<string, boolean>()
  for (const raw of Object.values(view.run_events ?? {})) {
    const link = raw as {run_id:number;event_id:number}
    const event = view.events?.[String(link.event_id)] as {detail?:unknown} | undefined
    if (typeof event?.detail !== "string" || !event.detail.startsWith("project:")) continue
    const id = event.detail.slice(8)
    if (!cache.has(id)) {
      const p = yield* kv.get("orchestra/project/"+id)
      cache.set(id, !!p && typeof p === "object" && !Array.isArray(p) && "workEnabled" in p && p.workEnabled === false)
    }
    if (cache.get(id)) paused.add(link.run_id)
  }
  return paused
})
/** Timer calculation only. Keep full rows and IDs in the decision view and journal. */
export function withoutPausedRuns(view: View, paused: ReadonlySet<number>): View {
  return {...view,runs:Object.fromEntries(Object.entries(view.runs ?? {}).filter(([id])=>!paused.has(Number(id))))}
}
