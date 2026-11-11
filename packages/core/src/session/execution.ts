export * as SessionExecution from "./execution.js"

import { Cause, Context, Effect, Exit, Layer } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Job } from "../job.js"
import { Instance } from "../instance/service.js"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { SessionEvent } from "./event.js"
import { SessionHandoff } from "./handoff.js"
import { SessionMemory } from "../memory/session.js"
import { SessionContinuation } from "./continuation.js"
import { KV } from "../kv.js"
import { SessionHold } from "./hold.js"
import { SessionRunCoordinator } from "./run-coordinator.js"
import { SessionRunner } from "./runner/index.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { toSessionError } from "./to-session-error.js"
import { NotFoundError } from "./error.js"
import { SessionInbox } from "./inbox.js"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Checks process-local ownership, including interruption cleanup and terminal settlement. */
  readonly isActive: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Interrupt active work owned by this process. Idle interruption is a no-op. Resolves once
   * the interruption is accepted; cleanup settles asynchronously in the execution fiber.
   * Returns whether an active execution was interrupted. Compose with `awaitIdle` when
   * settlement matters. `awaitSettlement` waits only for the interrupted execution,
   * rather than fresh work admitted during its cleanup.
   */
  readonly interrupt: (
    sessionID: SessionSchema.ID,
    options?: {
      readonly resume?: boolean
      readonly reason?: "user" | "inactivity"
      readonly awaitSettlement?: boolean
    },
  ) => Effect.Effect<boolean>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to its selected instance's runner. */
export class Service extends Context.Service<Service, Interface>()("@orchestra/SessionExecution") {}

type InterruptReason = "user" | "shutdown" | "inactivity" | "pause"

export type TerminalOutcome =
  | { readonly type: "succeeded" }
  | { readonly type: "interrupted"; readonly reason: InterruptReason }
  | { readonly type: "failed"; readonly error: ReturnType<typeof toSessionError> }

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: InterruptReason): TerminalOutcome {
  if (reason !== undefined) return { type: "interrupted", reason }
  if (Exit.isSuccess(exit)) return { type: "succeeded" }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted", reason: "shutdown" }
  return { type: "failed", error: toSessionError(Cause.squash(exit.cause)) }
}

/** Process-local execution: drains run in this process using the selected instance. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const continuationControl = yield* SessionContinuation.Service
    const kv = yield* KV.Service
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const bus = yield* Bus.Service
    const jobs = yield* Job.Service
    const db = (yield* Database.Service).db
    const reportLifecycle = <A>(sessionID: SessionSchema.ID, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                Effect.annotateLogs({ sessionID }),
              ),
        ),
        Effect.asVoid,
      )
    // Write-ahead claim: starting records the durable intent that a turn is in flight, in the same
    // transaction as the started event. Terminals release it — except shutdown interruption, which
    // preserves the claim so the next server start resumes the turn. A claim that survives with no
    // terminal is the signature of a process that died without teardown (crash, SIGKILL, eviction);
    // recovery is a property of the database, never of a shutdown hook that may not run.
    const claimOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => store.claim(sessionID),
    })
    const releaseOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => store.release(sessionID),
    })
    // A drain that keeps coming back as Moved/Reloaded is a loop, not progress: a closed
    // location answers every drain with Reloaded, and a session that keeps moving never
    // settles. Cap the hops; the work stays durable in the inbox and the next wake or boot
    // sweep picks it up again instead of spinning here. Reloads also wait briefly between
    // hops so a closed location cannot hot-loop the drain.
    const MAX_DRAIN_HOPS = 8
    const drain = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      force: boolean,
      continuation?: SessionRunner.Continuation,
      promotable: SessionInbox.Promotable = "input",
      hops = 0,
    ): Effect.fn.Return<void, SessionRunner.RunError> {
      if (!continuationControl.isEnabled()) return yield* Effect.interrupt
      const session = yield* store.get(sessionID)
      if (!session) return yield* new NotFoundError({ sessionID })
      const result = yield* SessionRunner.Service.use((runner) =>
        runner.drain({ sessionID, force, continuation, promotable }),
      ).pipe(
        instances.provide(session),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
        ),
      )
      if (result._tag !== "Complete" && hops >= MAX_DRAIN_HOPS) {
        yield* Effect.logWarning("Session drain stopped after too many moves/reloads; work stays queued", {
          sessionID,
          hops,
          next: result._tag,
        })
        return
      }
      return yield* SessionRunner.DrainResult.$match(result, {
        Complete: () => Effect.void,
        Moved: (result) => drain(sessionID, false, result.continuation, promotable, hops + 1),
        Reloaded: (result) =>
          Effect.sleep("250 millis").pipe(
            Effect.andThen(drain(sessionID, result.force, result.continuation, promotable, hops + 1)),
          ),
      })
    })
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError, InterruptReason>({
      started: (sessionID) =>
        reportLifecycle(
          sessionID,
          bus.publish(SessionEvent.Execution.Started, { sessionID }, claimOnCommit(sessionID)),
        ),
      drain: (sessionID, force, promotable) => drain(sessionID, force, undefined, promotable),
      // One terminal observation per busy period, covering every coalesced drain.
      settled: (sessionID, exit, reason) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            const outcome = terminal(exit, reason)
            if (outcome.type === "succeeded") {
              yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID }, releaseOnCommit(sessionID))
              yield* finalizeMemory(sessionID)
              return
            }
            if (outcome.type === "interrupted") {
              // Deliberate stops release the claim; shutdown keeps it for restart continuity.
              if (outcome.reason !== "shutdown" && outcome.reason !== "pause") yield* jobs.cancel(sessionID)
              yield* bus.publish(
                SessionEvent.Execution.Interrupted,
                { sessionID, reason: outcome.reason },
                outcome.reason === "shutdown" || outcome.reason === "pause" ? undefined : releaseOnCommit(sessionID),
              )
              // A stopped session leaves a handoff stub behind, so a resumed session or a
              // replacement agent finds where it stopped even when the agent never wrote
              // one itself. The stub never overwrites an agent-written handoff, and a
              // failure to write it must not fail the settlement.
              yield* writeHandoffStub(sessionID, outcome.reason)
              yield* finalizeMemory(sessionID)
              return
            }
            yield* bus.publish(
              SessionEvent.Execution.Failed,
              {
                sessionID,
                error: outcome.error,
              },
              releaseOnCommit(sessionID),
            )
            yield* writeHandoffStub(sessionID, "failed")
            yield* finalizeMemory(sessionID)
          }),
        ),
    })

    const removePauseListener = continuationControl.listen((enabled) => enabled ? Effect.void : Effect.gen(function* () {
      const active = yield* coordinator.active
      yield* Effect.forEach([...active], (id) => Effect.gen(function* () {
        yield* kv.set(SessionContinuation.pausedKey(id), true)
        yield* coordinator.interrupt(id, "pause", { awaitSettlement: true })
      }), { concurrency: 4, discard: true })
    }))
    yield* Effect.addFinalizer(() => Effect.sync(removePauseListener))

    // Best-effort L3 finalization (Б17): on every terminal outcome, writes
    // `memory.md` (≤ 8 KiB) and guarantees `handoff.md` exists. The summary
    // here is extractive (from the session journal): this layer has no
    // LLMClient/Model/SessionContext services, so the cheap-model summary
    // (`SessionMemorySummary.summarize`, B10 router tier `trivial`) is NOT
    // wired at settle — it is injectable through `finalizeSession`'s
    // `summarize` option, and wiring it needs either those services added
    // to this node or a hook at the runner drain end where they are in
    // scope. A failure here is a warning, never a failed settlement.
    const finalizeMemory = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const session = yield* store.get(sessionID)
        if (!session) return
        yield* SessionMemory.finalizeSession(session.location.directory, sessionID)
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Could not finalize session memory", {
                sessionID,
                error: Cause.pretty(cause),
              }),
        ),
      )

    // Best-effort handoff stub for a stopped session (see session/handoff.ts): the
    // session's project directory comes from the store, and anything that goes wrong
    // here is a warning, never a failed settlement.
    const writeHandoffStub = (sessionID: SessionSchema.ID, reason: SessionHandoff.Reason) =>
      Effect.gen(function* () {
        const session = yield* store.get(sessionID)
        if (!session) return
        yield* SessionHandoff.writeStubIfMissing(session.location.directory, sessionID, reason)
      }).pipe(
        // An interruption stays an interruption; anything else is a warning, so a
        // handoff that cannot be written never fails the settlement it rides on.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Could not write session handoff stub", {
                sessionID,
                error: Cause.pretty(cause),
              }),
        ),
      )

    return Service.of({
      active: coordinator.active,
      isActive: coordinator.isActive,
      interrupt: (sessionID, options) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const interrupted = yield* coordinator.interrupt(sessionID, options?.reason ?? "user", options)
            if (!options?.resume || !continuationControl.isEnabled()) return interrupted
            // Resume steering input and between-turn control work from the interrupted
            // intent. Queued next-turn prompts stay parked: a steer-scoped drain never
            // promotes them, and a control item behind a queued prompt waits its turn.
            // Interruption acknowledges before cleanup settles, so this wake usually lands
            // on the stopping execution's doorbell and starts the successor at settle.
            // Reading the inbox concurrently with the dying drain is safe: delivery consumes
            // rows inside uninterruptible publications, so a steer row is either still
            // promotable here or was fully delivered and needs no resumption.
            const next = yield* restore(SessionInbox.nextPromotable(db, sessionID, "input"))
            if (next === undefined) return interrupted
            if (next.delivery === "steer" || next.type === "compaction" || next.type === "move")
              yield* coordinator.wake(sessionID, "steer")
            return interrupted
          }),
        ),
      // A held session (a paused Society's) does not start from any path. Its durable work stays where it is
      // and starts when the hold is released.
      resume: (sessionID) =>
        Effect.uninterruptibleMask((restore) =>
          SessionHold.held(sessionID).pipe(
            Effect.flatMap((held) => (held || !continuationControl.isEnabled() ? Effect.void : restore(coordinator.run(sessionID)))),
          ),
        ),
      wake: (sessionID) =>
        Effect.uninterruptibleMask((restore) =>
          SessionHold.held(sessionID).pipe(
            Effect.flatMap((held) => (held || !continuationControl.isEnabled() ? Effect.void : coordinator.wake(sessionID))),
          ),
        ),
      awaitIdle: coordinator.awaitIdle,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, Instance.node, Bus.node, Database.node, Job.node, KV.node, SessionContinuation.node],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
