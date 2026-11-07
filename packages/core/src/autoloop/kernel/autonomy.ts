export * as AutoloopAutonomy from "./autonomy.js"

// Autonomy modes and router batching (news run5, DeepSeek
// dsh-super-agent-prototype, БРАТЬ №1 — ideas only, no prototype code).
//
// One long-lived router listens to events and decides what is work and
// what is noise; the society's autonomy mode says how much of that work
// it may take on its own:
//
// - `off` — the router takes nothing: events are still recorded in the
//   journal (the evidence stays), but nothing is routed, no run is
//   queued, no worker claims, and no human is notified.
// - `observe` (the default) — the router prepares but does not execute:
//   events route and queue runs as proposals, but `claimNext` hands
//   nothing out. Flipping the mode to `auto` resumes execution from the
//   queued proposals — no work is lost, and no dispatch is silently
//   dropped: `createRun` still returns null, so the task is not sent to
//   the worker session until the mode allows it.
// - `auto` — as before: route, queue, claim, execute.
//
// The kernel default when no mode is given is `auto`: existing callers
// (and their tests) keep the legacy behaviour. The operator-facing
// default is `observe`, resolved from `orchestra.society.autonomy` by
// `autonomyFromConfig` in `../orchestrator.ts` — a new society watches
// first and only executes when the operator says so.
//
// Silence rule — "speak only when the human must act or can use a
// result": every notice the kernel creates declares why the human needs
// it (`NotifyKind`: `action` — something needs doing; `result` — a
// finished outcome the human can use). There is no third kind: a notice
// that is neither must not be created at all. Ingest itself never
// notifies — N events in, zero cards out — so a burst of events stays
// silent. In `off` mode every notice is dropped at the gate.
//
// Batching — the router decides once per batch instead of once per
// event: `ingestBatch` records a whole burst in a single `decide` pass
// (one commit, one deadlines recompute), deduping inside the batch and
// against the journal, and coalescing same-rule, same-lane events into
// one queued run through the existing `enqueue`. The service accumulates
// single events into a batch for `batchWindowMs` (default 1s) or until
// `maxBatchEvents` (default 50) arrive, then flushes it in one pass.

/** How much work the router may take on its own. */
export const AUTONOMY_MODES = ["off", "observe", "auto"] as const
export type AutonomyMode = (typeof AUTONOMY_MODES)[number]

/** The operator-facing default: watch first, execute only when told to. */
export const DEFAULT_AUTONOMY: AutonomyMode = "observe"

/**
 * The mode a `decide` call runs in. No mode given means the legacy
 * behaviour (`auto`): the kernel must not change what existing callers
 * do — the `observe` default lives in the config layer, not here.
 */
export const resolveAutonomy = (given?: AutonomyMode): AutonomyMode => given ?? "auto"

/** Whether an event may be routed to a rule at all. */
export const canRoute = (mode: AutonomyMode): boolean => mode !== "off"

/** Whether a worker may claim a queued run and execute it. */
export const canClaim = (mode: AutonomyMode): boolean => mode === "auto"

/**
 * Why the human is told: `action` — something needs doing (a worker is
 * offline, a run is stuck on its last retry, a rule broke); `result` —
 * a finished outcome the human can use (a run stopped, a chain stopped,
 * a dispute reached the operator, a run finished with `tell: "always"`).
 */
export type NotifyKind = "action" | "result"

/**
 * Whether a notice of this kind reaches the human in this mode. `off`
 * is silent, full stop; `observe` and `auto` both tell the human exactly
 * the two things the silence rule allows — what needs doing, and what
 * is finished and usable. The modes differ in execution, not in what
 * the human hears: in `observe` the human is watching proposals, in
 * `auto` the cards are the only signal that something stopped.
 */
export const shouldNotify = (mode: AutonomyMode, _kind: NotifyKind): boolean => mode !== "off"

/** How the router accumulates events into one decision pass. */
export interface BatchLimits {
  /** How long single events accumulate before one pass, milliseconds. */
  windowMs: number
  /** How many events force a pass at once, however fresh. */
  maxEvents: number
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = {
  windowMs: 1000,
  maxEvents: 50,
}

/** Hard cap on one `ingestBatch` call: a single pass must stay bounded. */
export const MAX_BATCH_EVENTS = 200

export const resolveBatchLimits = (given?: Partial<BatchLimits>): BatchLimits => ({
  windowMs: Math.max(0, given?.windowMs ?? DEFAULT_BATCH_LIMITS.windowMs),
  maxEvents: Math.max(1, given?.maxEvents ?? DEFAULT_BATCH_LIMITS.maxEvents),
})

/**
 * Whether an accumulated batch is due for one decision pass: it hit the
 * size cap, or the window ran out since its first event. Pure, so the
 * service and the tests agree on exactly when a batch flushes.
 */
export const shouldFlushBatch = (count: number, firstAt: number, now: number, limits: BatchLimits): boolean =>
  count >= limits.maxEvents || now - firstAt >= limits.windowMs
