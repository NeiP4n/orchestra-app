export * as SessionRunCoordinator from "./run-coordinator.js"

import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"
import type { Promotable } from "./inbox.js"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E, Reason = never> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Checks ownership for one key, including cleanup and terminal settlement. */
  readonly isActive: (key: Key) => Effect.Effect<boolean>
  readonly whileIdle: <A, E2, R>(key: Key, effect: Effect.Effect<A, E2, R>) => Effect.Effect<A | undefined, E2, R>
  /** Starts an execution while idle, or joins the active execution and returns its exit. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Rings the doorbell: an idle key starts an execution; an active one drains again before settling. */
  readonly wake: (key: Key, scope?: Promotable) => Effect.Effect<void>
  /**
   * Stops the active execution and clears its doorbell. No-op when idle. Resolves once the
   * interruption is accepted, not when cleanup settles: the execution fiber finishes its
   * finalizers and settled hook on its own time. Returns whether an active execution was
   * interrupted. `awaitSettlement` waits for this execution's cleanup and settled hook,
   * without following fresh work admitted during cleanup. `awaitIdle` follows successors too.
   */
  readonly interrupt: (
    key: Key,
    reason?: Reason,
    options?: { readonly awaitSettlement?: boolean },
  ) => Effect.Effect<boolean>
  /** Resolves once no execution is active for the key. Returns immediately when already idle and never starts work. */
  readonly awaitIdle: (key: Key) => Effect.Effect<void>
}

/**
 * One execution is a busy period for one key: one fiber that drains from the first wake
 * until the key would stay idle. `pendingWake` is the doorbell: work recorded during the
 * execution rings it with the scope that work needs, and the execution loop drains again
 * instead of ending. The doorbell closes the gap between a drain's last eligibility check
 * and the idle transition, since those cannot be one atomic step. `done` resolves joiners
 * with this execution's exit.
 */
type Execution<E, Reason> = {
  readonly done: Deferred.Deferred<void, E>
  readonly interrupted: Deferred.Deferred<void>
  owner?: Fiber.Fiber<void>
  scope: Promotable
  pendingWake?: Promotable
  stopping: boolean
  phase: "starting" | "running" | "settling"
  interruptionReason?: Reason
}

/**
 * ```text
 *              wake | run
 *      idle ──────────────▶ execution (one fiber)
 *                             drain ⟲ doorbell rung mid-drain
 *                             │ exit (settled hook runs)
 *      doorbell quiet ◀───────┴───────▶ doorbell rung
 *      idle, waiters get exit          successor execution,
 *                                      waiters get this exit
 * ```
 */
export const make = <Key, E, Reason = never>(options: {
  readonly canRun?: () => boolean
  readonly drain: (key: Key, force: boolean, scope: Promotable) => Effect.Effect<void, E>
  /** Runs once when a process-local busy period begins, before its first drain. */
  readonly started?: (key: Key) => Effect.Effect<void>
  /**
   * Runs in the execution fiber for every exit, including interruption, after the final
   * drain and before the execution settles (waiters resolve after it completes).
   */
  readonly settled?: (key: Key, exit: Exit.Exit<void, E>, reason?: Reason) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, E, Reason>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const executions = new Map<Key, Execution<E, Reason>>()
    const idleReservations = new Map<Key, { done: Deferred.Deferred<void>; wake?: Promotable }>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const loop = (key: Key, execution: Execution<E, Reason>, force: boolean): Effect.Effect<void, E> =>
      Effect.suspend(() => options.drain(key, force, execution.scope)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (execution.stopping || execution.pendingWake === undefined) return Effect.void
            execution.scope = execution.pendingWake
            execution.pendingWake = undefined
            // Trampoline so drains that complete synchronously cannot grow the stack.
            return Effect.yieldNow.pipe(Effect.andThen(loop(key, execution, false)))
          }),
        ),
      )

    const start = (key: Key, force: boolean, scope: Promotable) => {
      const execution: Execution<E, Reason> = {
        done: Deferred.makeUnsafe<void, E>(),
        interrupted: Deferred.makeUnsafe<void>(),
        scope,
        stopping: false,
        phase: "starting",
      }
      executions.set(key, execution)
      // The leading yield lets `owner` be assigned before the drain can settle, and keeps
      // failing self-waking executions from growing the stack across successor starts.
      // Drains start one tick after wake; callers observe progress through events or run.
      const fiber = fork(
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if (execution.stopping || Deferred.isDoneUnsafe(execution.interrupted)) {
                return yield* Effect.interrupt
              }
              if (options.started) {
                yield* Effect.uninterruptible(options.started(key))
              }
              execution.phase = "running"
              if (execution.stopping || Deferred.isDoneUnsafe(execution.interrupted)) {
                return yield* Effect.interrupt
              }
              yield* loop(key, execution, force)
            }),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              execution.phase = "settling"
              execution.owner = undefined
            }).pipe(
              Effect.andThen(Effect.exit(options.settled?.(key, exit, execution.interruptionReason) ?? Effect.void)),
              Effect.andThen((settledExit) =>
                Effect.sync(() => {
                  // The settled hook reports cleanup or lifecycle failures. Keep them attached to the
                  // exit joiners observe instead of swallowing them, without changing the execution's
                  // typed error channel: the hook itself cannot fail with E.
                  if (Exit.isFailure(settledExit))
                    return settle(
                      key,
                      execution,
                      Exit.failCause(
                        Exit.isFailure(exit)
                          ? Cause.combine(exit.cause, Cause.map(settledExit.cause, () => undefined as never))
                          : Cause.map(settledExit.cause, () => undefined as never),
                      ),
                    )
                  settle(key, execution, exit)
                }),
              ),
            ),
          ),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      execution.owner = fiber
      if (execution.stopping) {
        fork(Fiber.interrupt(fiber))
      }
      return execution
    }

    // A doorbell that survives the execution loop (rung after the loop decided to end, or
    // during failure or interruption cleanup) starts a fresh execution for the remaining work.
    const settle = (key: Key, execution: Execution<E, Reason>, exit: Exit.Exit<void, E>) => {
      if (execution.pendingWake) start(key, false, execution.pendingWake)
      else executions.delete(key)
      Deferred.doneUnsafe(execution.done, exit)
    }

    const isActive = (key: Key) => Effect.sync(() => executions.has(key))

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (options.canRun?.() === false) return Effect.void
          const reserved = idleReservations.get(key)
          if (reserved) return restore(Deferred.await(reserved.done)).pipe(Effect.andThen(run(key)))
          const execution = executions.get(key)
          if (execution !== undefined) {
            // A stopping execution or an execution in terminal settlement refuses joiners: wait out its cleanup, then run fresh.
            if (execution.stopping || execution.phase === "settling")
              return restore(Deferred.await(execution.done)).pipe(Effect.ignoreCause, Effect.andThen(run(key)))
            // If the active execution is running with a narrower scope (e.g. steer),
            // coalesce so input is drained before settling without creating a duplicate execution.
            if (execution.scope !== "input") {
              execution.pendingWake = "input"
            }
            return restore(Deferred.await(execution.done))
          }
          const started = start(key, true, "input")
          return restore(Deferred.await(started.done))
        }),
      )

    const wake = (key: Key, scope: Promotable = "input") =>
      Effect.sync(() => {
        if (options.canRun?.() === false) return
        const reserved = idleReservations.get(key)
        if (reserved) { reserved.wake = reserved.wake === "input" ? "input" : scope; return }
        const execution = executions.get(key)
        if (execution !== undefined) {
          // Coalesced wakes keep the widest scope: "input" subsumes "steer".
          execution.pendingWake = execution.pendingWake === "input" ? "input" : scope
          return
        }
        start(key, false, scope)
      })

    const interrupt = (key: Key, reason?: Reason): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const execution = executions.get(key)
        if (execution === undefined || execution.stopping) return false
        if (execution.phase === "settling") {
          // Settlement window: the owner exited but the settled hook has not finished. The
          // terminal outcome is already decided, so no reason attaches — but the interrupt
          // still claims the recorded wakes so settle does not start a dead-intent successor.
          execution.pendingWake = undefined
          return false
        }
        execution.stopping = true
        // Wakes recorded so far belong to the interrupted intent; the interrupt claims them.
        // Wakes arriving during cleanup are new admissions and restart normally at settle.
        execution.pendingWake = undefined
        execution.interruptionReason = reason
        Deferred.doneUnsafe(execution.interrupted, Exit.void)
        if (execution.owner !== undefined) {
          // Fire and forget: nobody benefits from waiting out cleanup here, and callers like
          // the interrupt endpoint must acknowledge immediately even when finalizers are slow.
          fork(Fiber.interrupt(execution.owner))
        }
        return true
      })

    // One execution's `done` already spans coalesced continuations; re-check after it
    // settles to cover a successor execution started by a late doorbell.
    const awaitIdle = (key: Key): Effect.Effect<void> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const execution = executions.get(key)
          if (execution === undefined) return Effect.void
          return restore(Deferred.await(execution.done)).pipe(Effect.ignoreCause, Effect.andThen(awaitIdle(key)))
        }),
      )

    return {
      whileIdle: (key, effect) => Effect.suspend(() => {
        if (executions.has(key) || idleReservations.has(key)) return Effect.succeed(undefined)
        const reservation: { done: Deferred.Deferred<void>; wake?: Promotable } = { done: Deferred.makeUnsafe<void>() }
        idleReservations.set(key, reservation)
        return effect.pipe(Effect.ensuring(Effect.suspend(() => {
          idleReservations.delete(key)
          Deferred.doneUnsafe(reservation.done, Exit.void)
          return reservation.wake ? wake(key, reservation.wake) : Effect.void
        })))
      }),
      active: Effect.sync(() => new Set(executions.keys())),
      isActive,
      run,
      wake,
      interrupt: (key, reason, options) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            const execution = executions.get(key)
            return interrupt(key, reason).pipe(
              Effect.tap(() =>
                options?.awaitSettlement && execution
                  ? restore(Deferred.await(execution.done)).pipe(Effect.ignoreCause)
                  : Effect.void,
              ),
            )
          }),
        ),
      awaitIdle,
    }
  })
