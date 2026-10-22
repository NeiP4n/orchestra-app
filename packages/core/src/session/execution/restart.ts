export * as SessionRestart from "./restart.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { Bus } from "../../bus.js"
import { Job } from "../../job.js"
import { KV } from "../../kv.js"
import { Session } from "../../session.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { resumeBlockedKey } from "../restart-state.js"
import { SessionExecution } from "../execution.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { ShellResult } from "../../shell/result.js"
import { SubagentCompletion } from "../subagent-completion.js"

const CONTINUE_AFTER_SERVER_RESTART =
  "The server restarted while you were working. Continue from where you left off without repeating completed work."

const RESUME_EXHAUSTED = {
  type: "aborted",
  message: "Execution was interrupted repeatedly and will not be resumed automatically.",
} as const

export interface Options {
  /**
   * Times a single turn may be resumed before it is terminalized instead.
   * The counter is durable and only a terminal event resets it, so a turn
   * that keeps dying cannot crash-loop across restarts. Turns that complete
   * never accumulate: the budget is per-turn, not per-session.
   */
  readonly maxAttempts?: number
}

const DEFAULT_MAX_ATTEMPTS = 10

export interface Interface {
  /**
   * Resumes Sessions whose execution claim was never released — turns orphaned
   * by a process that died without teardown, or interrupted by a graceful
   * shutdown (which preserves the claim on purpose). The claim is never
   * cleared here: only a terminal event releases it, so a death anywhere in
   * the resume path leaves the same orphaned claim for the next boot.
   */
  readonly resumeSuspendedSessions: Effect.Effect<void>
}

/**
 * Recovery for orphaned executions. Claims are written at turn start by
 * SessionExecution, so this sweep needs no cooperation from the previous
 * process: crash, SIGKILL, isolate eviction, and graceful restart all leave
 * the same durable signature.
 *
 * Recovery is at-least-once: local coordination prevents concurrent drains,
 * not repeated external side effects after a crash.
 *
 * The sweep assumes every orphaned claim's owner is dead. The managed-server
 * protocol guarantees this: a successor is only spawned after the previous
 * process is confirmed dead (client service `kill`/`evict` poll the PID), the
 * registration lock admits one managed server at a time, and unregistered
 * servers sharing the database never sweep. The service is inert until called
 * — the managed server invokes it at boot; embedders may call it from their
 * own start-up.
 */
export class Service extends Context.Service<Service, Interface>()("@orchestra/SessionRestart") {}

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      const kv = yield* KV.Service
      const execution = yield* SessionExecution.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const sessions = yield* Session.Service
      const scope = yield* Effect.scope
      const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

      const prepareResume = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
        // Durable before the resume runs, so a crash inside the resumed turn is
        // counted by the next sweep and the budget cannot be dodged.
        const attempts = yield* store.countResume(sessionID)
        if (attempts === undefined) return false
        if (attempts > maxAttempts) {
          // Persist this before releasing the claim. The inbox-only sweep must not restart
          // the same parked work after a turn has exhausted its automatic retry budget.
          yield* kv.set(resumeBlockedKey(sessionID), true)
          // Terminalize instead: the release hook clears the claim and resets the
          // counter atomically with the terminal event.
          yield* bus.publish(
            SessionEvent.Execution.Failed,
            { sessionID, error: RESUME_EXHAUSTED },
            { commit: () => store.release(sessionID) },
          )
          return false
        }
        yield* bus.publish(SessionEvent.Synthetic, {
          sessionID,
          text: CONTINUE_AFTER_SERVER_RESTART,
          description: "Continuing after restart",
          metadata: { notice: "restart" },
        })
        return true
      })

      const recoverShell = Effect.fnUntraced(function* (
        background: Job.Background,
        recovery: Extract<Job.Recovery, { kind: "shell" }>,
      ) {
        const state = background.status === "running" ? "cancelled" : background.status
        const text =
          background.status === "running"
            ? "Command cancelled because the server restarted"
            : state === "completed"
              ? (background.output ?? "Command completed")
              : state === "error"
                ? (background.error ?? "Command failed")
                : "Command cancelled"

        yield* sessions
          .synthetic({
            id: background.notificationID,
            sessionID: recovery.sessionID,
            description: recovery.command,
            ...ShellResult.notification({
              jobID: background.id,
              shellID: recovery.shellID,
              command: recovery.command,
              state,
              text,
            }),
            // Restart notices must not revive idle owners of long-lived shells.
            // Interrupted executions resume separately after their notices are admitted.
            resume: false,
          })
          .pipe(
            Effect.catchTag("Session.NotFoundError", () => Effect.void),
            Effect.orDie,
          )
        yield* jobs.completeBackground(background.notificationID)
      })

      const recoverSubagent = Effect.fnUntraced(function* (
        background: Job.Background,
        recovery: Extract<Job.Recovery, { kind: "subagent" }>,
        suspended: ReadonlySet<SessionSchema.ID>,
      ) {
        const child = yield* store.get(recovery.childSessionID)
        if (!child || child.parentID !== recovery.parentSessionID || !(yield* store.get(recovery.parentSessionID))) {
          yield* jobs.completeBackground(background.notificationID)
          return
        }

        const notify = Effect.fnUntraced(function* (result: Pick<Job.Background, "status" | "output" | "error">) {
          yield* SubagentCompletion.deliver(sessions, jobs, {
            ...result,
            recovery,
            notificationID: background.notificationID,
            resume: suspended.has(recovery.parentSessionID) ? false : undefined,
          }).pipe(Effect.orDie)
        })

        if (background.status !== "running") {
          yield* notify(background)
          return
        }
        if (yield* execution.isActive(recovery.childSessionID)) return
        if (!(yield* prepareResume(recovery.childSessionID))) {
          yield* notify({ status: "error", error: RESUME_EXHAUSTED.message })
          return
        }

        yield* jobs.start({
          id: background.id,
          type: "subagent",
          title: recovery.description,
          notificationID: background.notificationID,
          recovery,
          run: execution.resume(recovery.childSessionID).pipe(
            Effect.andThen(store.context(recovery.childSessionID)),
            Effect.map((messages) => {
              const assistant = messages.findLast(
                (message) =>
                  message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
              )
              return SubagentCompletion.text(assistant)
            }),
          ),
        })
        yield* jobs.background(background.id)
        yield* jobs.wait({ id: background.id }).pipe(
          Effect.flatMap((result) => (result.info ? notify(result.info) : Effect.void)),
          Effect.forkIn(scope),
        )
      })

      return Service.of({
        resumeSuspendedSessions: Effect.gen(function* () {
          const active = yield* execution.active
          const pending = yield* jobs.pendingBackground
          const children = pending.flatMap((background) =>
            background.status === "running" && background.recovery.kind === "subagent"
              ? [background.recovery.childSessionID]
              : [],
          )
          // Early notices wait for recovery's accounting, including Sessions that exhaust their budget.
          const suspended = new Set(
            [...(yield* store.listSuspended()), ...children].filter((sessionID) => !active.has(sessionID)),
          )
          yield* store.releaseChildClaims(children)
          yield* Effect.forEach(
            // Admit shell outcomes before a recovered child can start its first model request.
            pending.toSorted((a, b) => Number(a.recovery.kind === "subagent") - Number(b.recovery.kind === "subagent")),
            Effect.fnUntraced(function* (background) {
              if ((yield* jobs.get(background.id))?.status === "running") return
              const recovery = background.recovery
              yield* recovery.kind === "shell"
                ? recoverShell(background, recovery)
                : recoverSubagent(background, recovery, suspended)
            }),
            { discard: true },
          )

          // Background completion can wake a parent, so inspect local ownership only after recovery.
          const resumed = yield* execution.active
          yield* Effect.forEach(
            (yield* store.listSuspended()).filter((sessionID) => !resumed.has(sessionID)),
            (sessionID) =>
              execution
                .resume(sessionID)
                .pipe(Effect.ignore, Effect.forkIn(scope), Effect.when(prepareResume(sessionID))),
            { concurrency: "unbounded", discard: true },
          )

          // A crash can land after InboxEnqueued commits but before the caller rings the
          // execution doorbell. Such a session has no execution claim, so the suspended-claim
          // sweep above cannot find it. Reconcile durable wake intent for top-level Sessions.
          // Child Sessions remain owned by Job/subagent recovery and are deliberately excluded.
          const activeAfterRecovery = yield* execution.active
          const claimedAfterRecovery = new Set(yield* store.listSuspended())
          const roots = (yield* sessions.list({ parentID: null })).data
          yield* Effect.forEach(
            roots.filter(
              (session) =>
                !activeAfterRecovery.has(session.id) && !claimedAfterRecovery.has(session.id),
            ),
            Effect.fnUntraced(function* (session) {
              // Preserve the exhausted budget across boots until a user explicitly resumes
              // this Session or adds new runnable input.
              if ((yield* kv.get(resumeBlockedKey(session.id))) === true) return
              const pending = yield* sessions
                .inbox(session.id)
                .pipe(Effect.orElseSucceed((): SessionInbox.Info[] => []))
              const shouldResume = pending.some((item) => {
                if (item.type === "move" || item.type === "compaction") return true
                if (item.type === "user") return item.payload.resumeOnStart ?? true
                // Legacy synthetic rows predate the explicit flag. Preserve their old no-wake
                // behavior for shell notifications; other synthetic inputs are actionable.
                return item.payload.resumeOnStart ?? (item.payload.metadata?.source !== "shell")
              })
              if (!shouldResume) return
              // Recheck after reading Inbox so concurrent delivery or a new durable claim wins.
              const active = yield* execution.active
              if (active.has(session.id)) return
              const claimed = yield* store.listSuspended()
              if (claimed.includes(session.id)) return
              // Do not loop through startup after a failed/empty recovery that left the same
              // runnable inbox work parked. A manual prompt/resume removes this marker.
              const attempt = Effect.gen(function* () {
                yield* execution.resume(session.id).pipe(Effect.ignore)
                yield* execution.awaitIdle(session.id)
                const active = yield* execution.active
                if (active.has(session.id)) return
                const claimed = yield* store.listSuspended()
                if (claimed.includes(session.id)) return
                const remaining = yield* sessions
                  .inbox(session.id)
                  .pipe(Effect.orElseSucceed((): SessionInbox.Info[] => []))
                const stillRunnable = remaining.some((item) => {
                  if (item.type === "move" || item.type === "compaction") return true
                  if (item.type === "user") return item.payload.resumeOnStart ?? true
                  return item.payload.resumeOnStart ?? (item.payload.metadata?.source !== "shell")
                })
                if (stillRunnable) yield* kv.set(resumeBlockedKey(session.id), true)
              })
              // Register the successor execution before the startup sweep returns, so callers
              // that await idle cannot race ahead of an unstarted recovery fiber.
              yield* attempt.pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
            }),
            { concurrency: "unbounded", discard: true },
          )
          // Async observers consult this set at delivery; later completions wake parents normally.
          suspended.clear()
        }),
      })
    }),
  )

export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [SessionStore.node, KV.node, SessionExecution.node, Bus.node, Job.node, Session.node],
})
