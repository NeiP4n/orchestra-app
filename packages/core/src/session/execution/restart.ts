export * as SessionRestart from "./restart.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { Bus } from "../../bus.js"
import { Job } from "../../job.js"
import { KV } from "../../kv.js"
import { Session } from "../../session.js"
import { SessionEvent } from "../event.js"
import { SessionHold } from "../hold.js"
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

const DEFAULT_MAX_ATTEMPTS = 2

/** How many sessions the startup sweep may admit for resume at once. */
const MAX_CONCURRENT_RESUMES = 4

export interface Interface {
  /**
   * Resumes Sessions whose execution claim was never released — turns orphaned
   * by a process that died without teardown, or interrupted by a graceful
   * shutdown (which preserves the claim on purpose). The claim is never
   * cleared here: only a terminal event releases it, so a death anywhere in
   * the resume path leaves the same orphaned claim for the next boot.
   *
   * One pass, not three: suspended claims and runnable inbox work are read
   * once, deduplicated, and resumed together — main sessions first, at most
   * `MAX_CONCURRENT_RESUMES` admitted at once. A turn is resumed at most
   * `maxAttempts` times (default 2) before it is terminalized instead.
   */
  readonly resumeSuspendedSessions: Effect.Effect<void>
}

/** One session the startup sweep may resume, with what decides its priority. */
export interface ResumeCandidate {
  readonly sessionID: SessionSchema.ID
  readonly kind: "suspended" | "inbox"
  /** Null for a main session: mains resume before their children. */
  readonly parentID: SessionSchema.ID | null
}

/** Main sessions first, then suspended claims before runnable inbox work. */
export const orderResumeCandidates = (candidates: ReadonlyArray<ResumeCandidate>): Array<ResumeCandidate> =>
  [...candidates].sort(
    (a, b) =>
      Number(a.parentID !== null) - Number(b.parentID !== null) ||
      Number(a.kind !== "suspended") - Number(b.kind !== "suspended"),
  )

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
        // A held child stays parked: resuming it would burn its restart budget while the
        // Society is paused, and execution.resume would no-op anyway. The background stays
        // pending; the next sweep after the hold releases recovers it.
        if (yield* SessionHold.held(recovery.childSessionID)) return
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
            // Bounded like the resume pass below: an unbounded sweep would start every
            // pending background job at once.
            pending.toSorted((a, b) => Number(a.recovery.kind === "subagent") - Number(b.recovery.kind === "subagent")),
            Effect.fnUntraced(function* (background) {
              if ((yield* jobs.get(background.id))?.status === "running") return
              const recovery = background.recovery
              yield* recovery.kind === "shell"
                ? recoverShell(background, recovery)
                : recoverSubagent(background, recovery, suspended)
            }),
            { concurrency: MAX_CONCURRENT_RESUMES, discard: true },
          )

          // One resume pass, not two sweeps: suspended claims and runnable
          // inbox work are read once, deduplicated (a suspended session with
          // runnable inbox is one candidate, claimed, not two), and resumed
          // together — main sessions first, at most MAX_CONCURRENT_RESUMES
          // admitted at once. Background completion above can wake a parent,
          // so local ownership is inspected only after recovery.
          const resumed = yield* execution.active
          const claimed = new Set(yield* store.listSuspended())
          const suspendedCandidates = (yield* store.listSuspended()).filter((sessionID) => !resumed.has(sessionID))
          const roots = (yield* sessions.list({ parentID: null })).data
          const inboxCandidates: Array<{ sessionID: SessionSchema.ID; parentID: null }> = []
          for (const session of roots) {
            if (resumed.has(session.id) || claimed.has(session.id)) continue
            // Preserve the exhausted budget across boots until a user explicitly resumes
            // this Session or adds new runnable input.
            if ((yield* kv.get(resumeBlockedKey(session.id))) === true) continue
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
            if (shouldResume) inboxCandidates.push({ sessionID: session.id, parentID: null })
          }
          const parents = new Map<SessionSchema.ID, SessionSchema.ID | null>()
          for (const sessionID of suspendedCandidates) {
            const info = yield* store.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
            parents.set(sessionID, info?.parentID ?? null)
          }
          const candidates = orderResumeCandidates([
            ...suspendedCandidates.map((sessionID) => ({
              sessionID,
              kind: "suspended" as const,
              parentID: parents.get(sessionID) ?? null,
            })),
            ...inboxCandidates.map((candidate) => ({ ...candidate, kind: "inbox" as const })),
          ])
          yield* Effect.forEach(
            candidates,
            Effect.fnUntraced(function* (candidate) {
              // A held session stays parked, whatever kind of candidate it is: resuming it
              // would no-op (execution.resume refuses held sessions) while prepareResume
              // burns its restart budget, and the inbox path would mark it blocked forever.
              // The claim and the inbox work stay durable; the next sweep after the hold
              // releases resumes them.
              if (yield* SessionHold.held(candidate.sessionID)) return
              if (candidate.kind === "suspended") {
                // Admitting the resume retires this session from the suspended set: a
                // subagent completion that lands after the sweep must wake it, not park
                // the notice. Sessions the sweep does not resume stay in the set, so
                // their early notices keep resume: false.
                const admitted = yield* prepareResume(candidate.sessionID)
                if (admitted) {
                  suspended.delete(candidate.sessionID)
                  yield* execution.resume(candidate.sessionID).pipe(Effect.ignore, Effect.forkIn(scope))
                }
                return
              }
              // Recheck after reading Inbox so concurrent delivery or a new durable claim wins.
              const active = yield* execution.active
              if (active.has(candidate.sessionID)) return
              if ((yield* store.listSuspended()).includes(candidate.sessionID)) return
              // Do not loop through startup after a failed/empty recovery that left the same
              // runnable inbox work parked. A manual prompt/resume removes this marker.
              const attempt = Effect.gen(function* () {
                yield* execution.resume(candidate.sessionID).pipe(Effect.ignore)
                yield* execution.awaitIdle(candidate.sessionID)
                const active = yield* execution.active
                if (active.has(candidate.sessionID)) return
                const claimed = yield* store.listSuspended()
                if (claimed.includes(candidate.sessionID)) return
                const remaining = yield* sessions
                  .inbox(candidate.sessionID)
                  .pipe(Effect.orElseSucceed((): SessionInbox.Info[] => []))
                const stillRunnable = remaining.some((item) => {
                  if (item.type === "move" || item.type === "compaction") return true
                  if (item.type === "user") return item.payload.resumeOnStart ?? true
                  return item.payload.resumeOnStart ?? (item.payload.metadata?.source !== "shell")
                })
                if (stillRunnable) yield* kv.set(resumeBlockedKey(candidate.sessionID), true)
              })
              // Register the successor execution before the startup sweep returns, so callers
              // that await idle cannot race ahead of an unstarted recovery fiber.
              yield* attempt.pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
            }),
            { concurrency: MAX_CONCURRENT_RESUMES, discard: true },
          )
          // The set is pruned, not cleared: a session the sweep resumed is deleted
          // when its resume is admitted, so a subagent completion that lands after
          // the sweep wakes it; a session the sweep did not resume stays in the set,
          // so its early notices keep resume: false and do not wake a parked parent.
          // The set is local to this sweep and is dropped with it once the fibers finish.
        }),
      })
    }),
  )

export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [SessionStore.node, KV.node, SessionExecution.node, Bus.node, Job.node, Session.node],
})
