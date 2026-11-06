export * as SessionActivation from "./activation.js"

import { Effect, Option, Schema } from "effect"
import { KV } from "../kv.js"
import { Session } from "../session.js"
import { SessionHold } from "./hold.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionEscalate } from "./runner/escalate.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

// Worker activation: a dispatched task is only real when the worker's model
// actually starts. The dispatch prompt schedules an advisory wake, and that
// wake can be lost — a held Society swallows it silently, a fresh session
// can miss it, a restart drops it. Nothing verified the start, so a worker
// could sit with a delivered task, zero tokens and no terminal outcome
// forever (the B14 shape: 26 of 27 workers never started).
//
// This module is the verification side of that fix. `Orchestra.dispatch`
// records a watch when it hands a task to a worker; the watch checks after
// N minutes whether a run started (input tokens > 0, or a live execution
// claim), restarts the worker once when it did not, and escalates to the
// Orchestrator when the restart also fails. No human gate anywhere: the
// escalation is a durable message to the Orchestrator, not a confirmation
// prompt.

export const DEFAULT_CHECK_MINUTES = 5
const MIN_CHECK_MINUTES = 1
const MAX_CHECK_MINUTES = 60

/** Minutes between dispatch and the activation check; env override, default 5. */
export function checkDelayMs(minutes?: number): number {
  const raw = minutes ?? Number(process.env.ORCHESTRA_ACTIVATION_CHECK_MINUTES ?? DEFAULT_CHECK_MINUTES)
  const parsed = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_CHECK_MINUTES
  const clamped = Math.min(MAX_CHECK_MINUTES, Math.max(MIN_CHECK_MINUTES, parsed))
  return clamped * 60_000
}

export const Status = Schema.Literals(["watching", "started", "restarted", "escalated", "held", "gone", "settled"])
export type Status = typeof Status.Type

export const Record = Schema.Struct({
  sessionID: SessionSchema.ID,
  projectID: Schema.String,
  mainID: SessionSchema.ID,
  messageID: Schema.optional(SessionMessage.ID),
  createdAt: Schema.Number,
  checkAfterMs: Schema.Number,
  attempts: Schema.Number,
  restarts: Schema.Number,
  status: Status,
  lastCheckAt: Schema.optional(Schema.Number),
  note: Schema.optional(Schema.String),
})
export type Record = typeof Record.Type

const decodeRecord = Schema.decodeUnknownOption(Record)
const encodeRecord = Schema.encodeSync(Record)

export const key = (sessionID: SessionSchema.ID) => `orchestra/activation/${sessionID}`

export interface Deps {
  readonly kv: KV.Interface
  readonly sessions: Session.Interface
  readonly store: SessionStore.Interface
}

/** A run counts as started when the model consumed input tokens or a turn is claimed. */
export function isStarted(signals: { readonly tokensInput: number; readonly claimed: boolean }): boolean {
  return signals.tokensInput > 0 || signals.claimed
}

/** Whether a pending inbox item is work the runner would pick up on a resume. */
export function isRunnable(item: SessionInbox.Info): boolean {
  if (item.type === "move" || item.type === "compaction") return true
  if (item.type === "user") return item.payload.resumeOnStart ?? true
  return item.payload.resumeOnStart ?? item.payload.metadata?.source !== "shell"
}

export type VerifyResult =
  | { readonly status: "started"; readonly tokensInput: number; readonly claimed: boolean }
  | { readonly status: "idle"; readonly tokensInput: number; readonly pending: number }
  | { readonly status: "held" }
  | { readonly status: "gone" }
  | { readonly status: "settled"; readonly note: string }

export const verify = Effect.fn("SessionActivation.verify")(function* (deps: Deps, sessionID: SessionSchema.ID) {
  const info = yield* deps.store.get(sessionID)
  if (!info) return { status: "gone" } as VerifyResult
  if (yield* SessionHold.held(sessionID)) return { status: "held" } as VerifyResult
  const tokensInput = info.tokens.input
  const claimed = (yield* deps.store.listSuspended()).includes(sessionID)
  if (isStarted({ tokensInput, claimed })) return { status: "started", tokensInput, claimed } as VerifyResult
  // A failed or interrupted run already ended: its own reporting
  // (team-report, error ladder) owns the outcome, not this watch. A run
  // that "succeeded" without a model run and with work still pending did
  // not start the worker — it falls through to the pending check below.
  if (info.outcome === "failed" || info.outcome === "interrupted")
    return { status: "settled", note: `run ended with outcome ${info.outcome} without a model run` } as VerifyResult
  const pending = (yield* deps.sessions.inbox(sessionID).pipe(Effect.orElseSucceed(() => []))).filter(isRunnable)
  if (pending.length === 0)
    return { status: "settled", note: "no runnable work pending and no model run recorded" } as VerifyResult
  return { status: "idle", tokensInput, pending: pending.length } as VerifyResult
})

const updateRecord = Effect.fn("SessionActivation.updateRecord")(function* (
  deps: Deps,
  sessionID: SessionSchema.ID,
  patch: Partial<Pick<Record, "status" | "attempts" | "restarts" | "lastCheckAt" | "note">>,
) {
  const current = Option.getOrUndefined(decodeRecord(yield* deps.kv.get(key(sessionID))))
  if (!current) return
  yield* deps.kv.set(key(sessionID), encodeRecord({ ...current, ...patch }))
})

const escalate = Effect.fn("SessionActivation.escalate")(function* (
  deps: Deps,
  input: { readonly sessionID: SessionSchema.ID; readonly mainID: SessionSchema.ID; readonly restarts: number },
) {
  // The existing error ladder, reused, not duplicated: a worker that never
  // started has exhausted its restarts, so the ladder names the next rung.
  // This layer cannot see society/president membership, so the target is
  // the Orchestrator — it climbs the ladder further from there.
  const escalation = SessionEscalate.ladder({
    cause: new Error(`Worker ${input.sessionID} did not start after ${input.restarts} restart(s)`),
    limitsExhausted: true,
  })
  yield* deps.sessions
    .synthetic({
      sessionID: input.mainID,
      description: `Worker did not start: ${input.sessionID}`,
      text: [
        `<activation-failure session="${input.sessionID}">`,
        `Worker ${input.sessionID} never started: no input tokens and no execution claim after dispatch, and a restart did not start it either.`,
        `Escalation: ${escalation.target}. ${escalation.reason}`,
        "The task is still queued in the worker's inbox (or was consumed without a model run). Reassign it or inspect the worker session; do not assume it is running.",
        "</activation-failure>",
      ].join("\n"),
      metadata: { source: "activation", sessionID: input.sessionID, target: escalation.target },
    })
    .pipe(Effect.ignore)
  yield* Effect.logWarning("worker never started; escalated to the orchestrator", {
    sessionID: input.sessionID,
    target: escalation.target,
  })
})

/**
 * Record a watch at dispatch time and check it in the background: after
 * `checkAfterMs` verify the run started; restart once when it did not, then
 * verify again and escalate when the restart also failed. Best-effort end
 * to end: a failure here must never fail the dispatch that forked it.
 */
export const watch = Effect.fn("SessionActivation.watch")(function* (
  deps: Deps,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly projectID: string
    readonly mainID: SessionSchema.ID
    readonly messageID?: SessionMessage.ID
    readonly checkAfterMs?: number
  },
) {
  const checkAfterMs = input.checkAfterMs ?? checkDelayMs()
  const record: Record = {
    sessionID: input.sessionID,
    projectID: input.projectID,
    mainID: input.mainID,
    ...(input.messageID ? { messageID: input.messageID } : {}),
    createdAt: Date.now(),
    checkAfterMs,
    attempts: 0,
    restarts: 0,
    status: "watching",
  }
  yield* deps.kv.set(key(input.sessionID), encodeRecord(record))
  yield* Effect.sleep(checkAfterMs)
  const first = yield* verify(deps, input.sessionID).pipe(
    Effect.catchCause((cause) => Effect.logWarning("activation check failed", { cause }).pipe(Effect.as(undefined))),
  )
  if (first === undefined) return
  if (first.status !== "idle") {
    yield* updateRecord(deps, input.sessionID, {
      status: first.status,
      attempts: 1,
      lastCheckAt: Date.now(),
      ...(first.status === "settled" ? { note: first.note } : {}),
    })
    return
  }
  yield* Effect.logWarning("worker did not start after dispatch; restarting it", {
    sessionID: input.sessionID,
    pending: first.pending,
  })
  yield* deps.sessions.resume(input.sessionID).pipe(Effect.ignore)
  yield* updateRecord(deps, input.sessionID, { status: "restarted", attempts: 1, restarts: 1, lastCheckAt: Date.now() })
  yield* Effect.sleep(checkAfterMs)
  const second = yield* verify(deps, input.sessionID).pipe(
    Effect.catchCause((cause) => Effect.logWarning("activation re-check failed", { cause }).pipe(Effect.as(undefined))),
  )
  if (second === undefined) return
  if (second.status === "started" || second.status === "settled" || second.status === "held" || second.status === "gone") {
    yield* updateRecord(deps, input.sessionID, {
      status: second.status,
      attempts: 2,
      lastCheckAt: Date.now(),
      ...(second.status === "settled" ? { note: second.note } : {}),
    })
    return
  }
  yield* escalate(deps, { sessionID: input.sessionID, mainID: input.mainID, restarts: 1 })
  yield* updateRecord(deps, input.sessionID, {
    status: "escalated",
    attempts: 2,
    lastCheckAt: Date.now(),
    note: "no model run after dispatch and one restart",
  })
})
