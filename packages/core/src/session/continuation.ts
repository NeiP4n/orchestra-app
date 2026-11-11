export * as SessionContinuation from "./continuation.js"

import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { KV } from "../kv.js"

export const KEY = "session/continuation-enabled"
export const PAUSED = "session/operator-paused/"
export const pausedKey = (id: string) => PAUSED + id
type Listener = (enabled: boolean) => Effect.Effect<void>
export interface Interface {
  readonly enabled: Effect.Effect<boolean>
  /** Wait for pause/resume cleanup before reporting operator-visible state. */
  readonly settled: Effect.Effect<boolean>
  readonly isEnabled: () => boolean
  readonly set: (enabled: boolean) => Effect.Effect<void>
  readonly listen: (listener: Listener, priority?: number) => () => void
}
export class Service extends Context.Service<Service, Interface>()("@orchestra/SessionContinuation") {}
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const lock = yield* Semaphore.make(1)
    const listeners = new Set<{ listener: Listener; priority: number }>()
    const initial = yield* kv.get(KEY)
    // Read once per owning runtime. Admission is synchronous with the local gate;
    // awaiting IO before registering a run would race startup's awaitIdle callers.
    let state = initial === undefined || initial === true
    const enabled = Effect.sync(() => state)
    return Service.of({
      enabled,
      settled: lock.withPermits(1)(enabled),
      isEnabled: () => state,
      set: (value) =>
        lock.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              // Close admission durably before interrupting any execution. A process death here
              // leaves orphaned claims parked for the next boot, not forgotten or replayed.
              yield* kv.set(KEY, value)
              state = value
              for (const entry of [...listeners].sort((a, b) => a.priority - b.priority)) yield* entry.listener(value)
            }),
          ),
        ),
      listen: (listener, priority = 0) => {
        const entry = { listener, priority }
        listeners.add(entry)
        return () => {
          listeners.delete(entry)
        }
      },
    })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node] })
