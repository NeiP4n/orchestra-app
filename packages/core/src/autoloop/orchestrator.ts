export * as AutoloopOrchestrator from "./orchestrator.js"

import type { ConfigOrchestra } from "@orchestra/schema/config/orchestra"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import type { Autoloop } from "./service.js"
import { AutoloopCards } from "./cards.js"
import type { AutoloopLimits, Job, Receipt, Rejected, RunRow } from "./kernel/decide.js"
import { DEFAULT_AUTONOMY, type AutonomyMode, type BatchLimits } from "./kernel/autonomy.js"
import { emptyRules, type Rules } from "./kernel/rules.js"

// The bridge between the Orchestrator and the autoloop cycle (block Б3,
// подшаг 4): `dispatch()` creates a run here, `report()` finishes it here.
// Nothing here runs a model or touches a session — it only drives the cycle
// service, and the journal stays the source of truth: run ids and tokens
// live in the durable task marker (`orchestra/task/<session>`), never in
// process memory, and `finishRun` reads the run's state fresh from the
// journal before finishing it.
//
// The worker claiming runs is the Orchestrator itself (`orchestra`): it
// claims on behalf of the worker session and finishes the run when that
// session's execution ends. The worker session is recorded on the run
// (`started`, and the receipt's `session`), so the journal still says who
// did the work.

/** The worker identity that claims runs on behalf of worker sessions. */
export const WORKER = "orchestra"

/** The one rule dispatch uses. */
export const TASK_RULE = "orchestra-task"

/** Where dispatch events come from, and what they are called. */
export const TASK_SOURCE = "orchestra"
export const TASK_TYPE = "task.created"

/**
 * How many runs may be claimed at once, across all projects. One per worker
 * session; the society target is more than 20 agents, so 30 leaves room for
 * every worker to hold a run while a few retries wait. Past this,
 * `claimNext` returns nothing and dispatch fails loudly instead of
 * queueing work the cycle cannot see.
 */
export const MAX_CONCURRENT_RUNS = 30

/** Receipt text is capped by the kernel at 2000 chars; stay under it. */
const SUMMARY_LIMIT = 1900

/** A run already over: `finish` on it is a no-op, never a second receipt. */
const TERMINAL: ReadonlyArray<string> = ["done", "nothing", "failed", "cancelled"]

/**
 * The cycle rules dispatch runs on. One rule: a `task.created` event from
 * the Orchestrator goes to the `orchestrator` agent, in the `orchestra`
 * group, one lane per worker session (so workers never block each other)
 * and up to `MAX_CONCURRENT_RUNS` claimed at once. `tell: "needed"` — a
 * finished run stays quiet; only failures and stops tell the owner, through
 * the cards `decide` creates. No roles are needed here: the run's agent is
 * the Orchestrator, and the worker session rides on the run itself.
 */
export function orchestraRules(timezone = "UTC"): Rules {
  return {
    ...emptyRules(timezone),
    sources: { [TASK_SOURCE]: { name: TASK_SOURCE } },
    agents: {
      orchestrator: { name: "orchestrator", worker: WORKER, use: "orchestra", access: "full" },
    },
    channels: { web: { name: "web" } },
    rules: [
      {
        name: TASK_RULE,
        when: { source: TASK_SOURCE, types: [TASK_TYPE] },
        to: "orchestrator",
        cwd: "",
        group: "orchestra",
        tell: "needed",
        parallel: MAX_CONCURRENT_RUNS,
      },
    ],
  }
}

/** Cycle limits from the operator's `Config.Orchestra.Autoloop`, if any. Missing numbers fall back to the kernel defaults. */
export function limitsFromConfig(autoloop: ConfigOrchestra.Autoloop | undefined): Partial<AutoloopLimits> {
  if (autoloop === undefined) return {}
  const picked: Partial<AutoloopLimits> = {}
  if (autoloop.maxAttempts !== undefined) picked.maxAttempts = autoloop.maxAttempts
  if (autoloop.maxVerifyIterations !== undefined) picked.maxVerifyIterations = autoloop.maxVerifyIterations
  if (autoloop.maxHops !== undefined) picked.maxHops = autoloop.maxHops
  if (autoloop.retryBaseMinutes !== undefined) picked.retryBaseMinutes = autoloop.retryBaseMinutes
  if (autoloop.retryMaxMinutes !== undefined) picked.retryMaxMinutes = autoloop.retryMaxMinutes
  if (autoloop.runLeaseMinutes !== undefined) picked.runLeaseMinutes = autoloop.runLeaseMinutes
  if (autoloop.workerFreshMinutes !== undefined) picked.workerFreshMinutes = autoloop.workerFreshMinutes
  if (autoloop.offlineAfterMinutes !== undefined) picked.offlineAfterMinutes = autoloop.offlineAfterMinutes
  return picked
}

/**
 * The Society's autonomy mode from the operator's `Config.Orchestra`
 * (`orchestra.society.autonomy`). Nothing set means `observe` — the
 * router watches and prepares, but executes nothing until the operator
 * says `auto`. A live autonomous society must set `auto` explicitly;
 * that is the gate, not a silent default.
 */
export function autonomyFromConfig(info: ConfigOrchestra.Info | undefined): AutonomyMode {
  return info?.society?.autonomy ?? DEFAULT_AUTONOMY
}

/** Router batch limits from the operator's `Config.Orchestra.Autoloop`, if any. Missing numbers fall back to the kernel defaults. */
export function batchLimitsFromConfig(autoloop: ConfigOrchestra.Autoloop | undefined): Partial<BatchLimits> {
  if (autoloop === undefined) return {}
  const picked: Partial<BatchLimits> = {}
  if (autoloop.batchWindowMs !== undefined) picked.windowMs = autoloop.batchWindowMs
  if (autoloop.maxBatchEvents !== undefined) picked.maxEvents = autoloop.maxBatchEvents
  return picked
}

/**
 * Add the dispatch rule to rules stored in the journal without shadowing
 * them: the operator's sources, agents and channels stay, their rule list
 * stays in order, and the dispatch rule is appended only when no rule with
 * its name is there yet. A stored rule of the same name wins — the operator
 * said what dispatch means.
 */
export function mergeDispatchRule(stored: Rules, timezone = "UTC"): Rules {
  const dispatch = orchestraRules(timezone)
  return {
    ...stored,
    sources: { ...stored.sources, ...dispatch.sources },
    agents: { ...stored.agents, ...dispatch.agents },
    channels: { ...stored.channels, ...dispatch.channels },
    rules: stored.rules.some((rule) => rule.name === TASK_RULE) ? stored.rules : [...stored.rules, ...dispatch.rules],
  }
}

const clipped = (text: string): string => (text.length > SUMMARY_LIMIT ? text.slice(0, SUMMARY_LIMIT) : text)

/**
 * A session outcome becomes a cycle receipt. The receipt carries what the
 * Orchestrator actually verified, not just what the worker said:
 * `report()` demotes a claimed DONE to `partial` when the transcript cannot
 * back it up (a check failed, no check ran, the CHECKS were copied, or files
 * were edited after the last run) — that partial becomes `verifyFailed`, so
 * the kernel's code-check branch requeues the run for another fix round
 * instead of recording it done. A worker that admits the task is not done
 * (`incomplete`) or failed (`failed`) gets a `failed` receipt, which retries
 * through the cycle limits; `unknown` (no status line at all) stays `done`,
 * because no claim was made either way. `stopped` is `cancelled`: final, no
 * retries. `recovered` is honest about what the transcript proves: a
 * complete outcome counts as done, a partial one as a failed verification,
 * anything else as failed. `nothing` is its own receipt: the run ended,
 * there was nothing to do, and no retry or card follows.
 */
export function receiptForReport(input: {
  state: "done" | "failed" | "stopped" | "recovered" | "nothing"
  outcome: "complete" | "partial" | "incomplete" | "unknown" | "failed" | "stopped"
  summary: string
  error?: string
  workerRemoved: boolean
  /**
   * The worker declared this run a bug fix (idea #6). Passed through to the
   * receipt: the kernel's test-before-fix gate then requires `failingTest`,
   * and a fix without it counts a verification round instead of done.
   */
  fixTask?: boolean
  /** The failing test that reproduces the bug: test file + recorded failing run. */
  failingTest?: { file: string; run: string }
  /**
   * Independent verification methods the worker used (idea #14). Passed
   * through to the receipt: the kernel requires two of different kinds
   * when the field is present. The caller in `orchestra.ts` builds these
   * from its two independent signals — the worker's CHECKS and the
   * transcript evidence — when both exist.
   */
  verification?: ReadonlyArray<{ kind: string; detail: string }>
}): Receipt {
  const summary = clipped(input.summary)
  const error = input.error === undefined ? undefined : clipped(input.error)
  // The failing-first proof rides only on receipts that claim success: a
  // failed or cancelled run has nothing to prove.
  const fixProof =
    input.fixTask !== true
      ? {}
      : {
          fixTask: true as const,
          ...(input.failingTest === undefined ? {} : { failingTest: input.failingTest }),
        }
  const verificationProof =
    // The receipt carries a mutable list; the caller may hand over the
    // read-only array stored in the task marker.
    input.verification === undefined ? {} : { verification: [...input.verification] }
  if (input.state === "nothing") return { outcome: "nothing", summary }
  if (input.workerRemoved) {
    return { outcome: "failed", summary, error: error ?? "worker session was removed before it could report" }
  }
  if (input.state === "failed") return { outcome: "failed", summary, error }
  if (input.state === "stopped") return { outcome: "cancelled", summary }
  if (input.state === "recovered") {
    if (input.outcome === "complete") return { outcome: "done", summary, ...fixProof, ...verificationProof }
    if (input.outcome === "partial") {
      return {
        outcome: "done",
        summary,
        verifyFailed: true,
        error: error ?? "recovered partially: the check did not pass",
        ...fixProof,
        ...verificationProof,
      }
    }
    return { outcome: "failed", summary, error: error ?? "recovered without a terminal event" }
  }
  if (input.outcome === "partial") {
    return { outcome: "done", summary, verifyFailed: true, error: error ?? "check did not pass: work is partial", ...fixProof, ...verificationProof }
  }
  if (input.outcome === "failed" || input.outcome === "incomplete") {
    return { outcome: "failed", summary, error }
  }
  return { outcome: "done", summary, ...fixProof, ...verificationProof }
}

/**
 * Whether a run that ended did nothing at all: no final answer and no trace
 * of work in the transcript (no command ran, no file edited). A worker that
 * only read files, or answered nothing after doing nothing, counts as
 * nothing; any command or edit counts as work, even without an answer.
 */
export function looksLikeNothing(answer: string, transcriptNote: string): boolean {
  return answer === "(no text answer)" && transcriptNote === ""
}

/** The cycle service, narrowed to what this bridge calls. */
export type Cycle = Pick<Autoloop.Interface, "execute" | "getView" | "heartbeat">

export interface DispatchTask {
  sessionID: string
  projectID: string
  text: string
  messageID: string
}

/**
 * Create the run for one dispatch: ingest the event, claim the run the
 * cycle hands back, record the worker session on it, and mark the worker
 * seen so a long task is not mistaken for a worker gone quiet. Returns
 * null when the cycle hands back no run — the rule is missing, or
 * `MAX_CONCURRENT_RUNS` runs are already claimed. The run the claim hands
 * back is the cycle's oldest claimable one, which is normally the run this
 * event just queued; after a crash mid-dispatch it can be an orphaned run
 * from an earlier dispatch, and the journal's `run_events` still say which
 * event each run belongs to.
 */
export function createRun(
  cycle: Cycle,
  task: DispatchTask,
): Effect.Effect<{ run: number; token: string } | null, Autoloop.ServiceFailure> {
  return Effect.gen(function* () {
    // The dispatch rule has to exist before the event is ingested: ingest
    // routes once, at ingest time, and storing the rule later strands the
    // event with no run. The service installs the rule from the operator
    // config when one is around; the bridge installs it in the journal so a
    // dispatch works in any context, even without one. Operator rules stay:
    // the dispatch rule is merged into them, never written over them.
    const view = yield* cycle.getView()
    const stored = AutoloopCards.storedRules(view)
    if (stored === undefined || !stored.rules.rules.some((rule) => rule.name === TASK_RULE)) {
      yield* cycle.execute({
        type: "rules",
        args: [stored === undefined ? orchestraRules() : mergeDispatchRule(stored.rules)],
      })
    }
    const ingested = (yield* cycle.execute({
      type: "ingest",
      args: [
        TASK_SOURCE,
        {
          id: task.messageID,
          type: TASK_TYPE,
          subject: task.sessionID,
          summary: clipped(task.text),
          detail: `project:${task.projectID}`,
          link: "",
          hops: 0,
        },
      ],
    })) as { event: number; duplicate: boolean; routed: string[]; dropped: boolean }
    const job = (yield* cycle.execute({
      type: "claimNext",
      args: [WORKER, `dispatch:${task.messageID}`],
    })) as Job | null
    if (job === null) {
      if (ingested.dropped === true) {
        // `off` mode: the event is recorded and nothing is routed — the
        // task is not sent, and that is the mode working, not a failure.
        yield* Effect.logInfo("autoloop: автономность выключена — событие записано, задача не отправлена", {
          event: ingested.event,
        })
      } else {
        yield* Effect.logWarning("autoloop: цикл не отдал задачу диспетча", { event: ingested.event })
      }
      return null
    }
    yield* cycle.execute({ type: "started", args: [job.run, job.token, { session: task.sessionID }] })
    yield* cycle.heartbeat(WORKER, [job.run])
    return { run: job.run, token: job.token }
  })
}

export type FinishStatus = "finished" | "already-finished" | "conflict" | "missing"

export interface FinishResult {
  status: FinishStatus
  rejected: Rejected[]
}

/** The run's current state, read fresh from the journal. */
export function readRun(cycle: Cycle, run: number): Effect.Effect<RunRow | undefined, Autoloop.ServiceFailure> {
  return Effect.gen(function* () {
    const view = yield* cycle.getView()
    return view["runs"]?.[String(run)] as RunRow | undefined
  })
}

/**
 * Finish a run with a receipt. Reads the run from the journal first: a run
 * already over, or one the journal never saw, is left alone. A receipt
 * handed in twice with the same token is the same answer, not a second
 * finish; a different receipt under the same token is a conflict, and the
 * first receipt stands.
 */
export function finishRun(
  cycle: Cycle,
  input: { run: number; token: string; receipt: Receipt },
): Effect.Effect<FinishResult, Autoloop.ServiceFailure> {
  return Effect.gen(function* () {
    const row = yield* readRun(cycle, input.run)
    if (row === undefined) return { status: "missing" as const, rejected: [] }
    if (TERMINAL.includes(row.state)) return { status: "already-finished" as const, rejected: [] }
    const finished = (yield* cycle.execute({
      type: "finish",
      args: [input.run, input.token, input.receipt],
    })) as { rejected: Rejected[]; duplicate?: boolean }
    return {
      status: finished.duplicate === true ? ("already-finished" as const) : ("finished" as const),
      rejected: finished.rejected,
    }
  }).pipe(
    Effect.catchTag("Autoloop.ServiceFailure", (error) =>
      error.code === "conflict"
        ? Effect.succeed({ status: "conflict" as const, rejected: [] })
        : Effect.fail(error),
    ),
  )
}

/** End a run as cancelled: final, no retries — for a task that never reached its worker. */
export function cancelRun(
  cycle: Cycle,
  input: { run: number; token: string; reason: string },
): Effect.Effect<void, never> {
  return finishRun(cycle, {
    run: input.run,
    token: input.token,
    receipt: { outcome: "cancelled", summary: input.reason },
  }).pipe(Effect.ignore)
}

/** Mark the worker seen, with this run still in hand. */
export function heartbeatRun(cycle: Cycle, run: number): Effect.Effect<void, Autoloop.ServiceFailure> {
  return cycle.heartbeat(WORKER, [run])
}

/**
 * Claim the oldest due re-queued run, if any — the FIFO re-claim a run after
 * `failed` waits for (block Б4). `claimNext` already hands back the oldest
 * claimable run, oldest first, so this is the same claim without a new
 * event: a run whose retry pause has passed is picked up again instead of
 * waiting for the next dispatch to happen to claim it. A fresh claim id per
 * call means a second call claims the next run, never the same one twice.
 * Returns null when nothing is due.
 */
export function claimDueRun(cycle: Cycle, now = Date.now()): Effect.Effect<Job | null, Autoloop.ServiceFailure> {
  return Effect.gen(function* () {
    const job = (yield* cycle.execute(
      {
        type: "claimNext",
        args: [WORKER, `reclaim:${randomUUID()}`],
      },
      now,
    )) as Job | null
    return job
  })
}
