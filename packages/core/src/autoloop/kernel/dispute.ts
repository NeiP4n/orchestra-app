export * as AutoloopDispute from "./dispute.js"

// Dispute ladder with a timer (idea #18): a disagreement climbs
// agent → group leader → council → orchestrator → operator, and every
// level must answer within its time. When the time runs out, the question
// moves up on its own, carrying both positions with it — a dispute never
// hangs for days and never jumps straight to the operator.
//
// The operator is the last rung, but only as a record: reaching it writes
// a notice card and marks the dispute `noted`. It never blocks work and
// never asks for permission — autonomy by default, no approval gates.
//
// Pure — no Effect, no I/O — so the kernel (`decide.ts`) can fold it into
// the journal and the session runner (`escalate.ts`) can re-export it. The
// error ladder in `escalate.ts` stays as it is: errors climb by exhaustion,
// disputes climb by time.

/** The rungs, lowest first. */
export const DISPUTE_LEVELS = ["agent", "group-leader", "council", "orchestrator", "operator"] as const

export type DisputeLevel = (typeof DISPUTE_LEVELS)[number]

/**
 * Minutes each level has to answer. The operator has none: it is a record,
 * not a deadline.
 */
export const DISPUTE_TIMEOUT_MINUTES: Record<Exclude<DisputeLevel, "operator">, number> = {
  agent: 15,
  "group-leader": 30,
  council: 60,
  orchestrator: 120,
}

/** One dispute, as stored in the journal's `disputes` collection. */
export interface Dispute {
  readonly id: number
  readonly subject: string
  readonly positionA: string
  readonly positionB: string
  readonly level: DisputeLevel
  /** ISO deadline for the current level to answer; "" at the operator (no deadline). */
  readonly deadline: string
  readonly state: "open" | "resolved" | "noted"
  readonly decision: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** The next rung up, or null past the operator. */
export function nextLevel(level: DisputeLevel): DisputeLevel | null {
  const index = DISPUTE_LEVELS.indexOf(level)
  return index < 0 || index + 1 >= DISPUTE_LEVELS.length ? null : DISPUTE_LEVELS[index + 1]!
}

/** ISO deadline for `level` from `nowMs`, or "" for the operator (no deadline). */
export function deadlineFor(level: DisputeLevel, nowMs: number): string {
  if (level === "operator") return ""
  return new Date(nowMs + DISPUTE_TIMEOUT_MINUTES[level] * 60_000).toISOString()
}

/** True when an open dispute's deadline has passed. */
export function isOverdue(dispute: Pick<Dispute, "state" | "deadline">, nowMs: number): boolean {
  return dispute.state === "open" && dispute.deadline !== "" && Date.parse(dispute.deadline) <= nowMs
}

/** One step up, whatever the clock says. Into the operator means recorded, not waiting. */
export function advanceDispute(
  dispute: Dispute,
  nowMs: number,
): { dispute: Dispute; escalated: boolean; reason: string } {
  if (dispute.state !== "open") {
    return { dispute, escalated: false, reason: `спор ${dispute.state === "resolved" ? "уже решён" : "уже записан для оператора"}` }
  }
  const next = nextLevel(dispute.level)
  if (next === null) {
    return { dispute, escalated: false, reason: "спор уже у оператора — выше некуда" }
  }
  if (next === "operator") {
    const noted: Dispute = { ...dispute, level: "operator", deadline: "", state: "noted", updatedAt: new Date(nowMs).toISOString() }
    return {
      dispute: noted,
      escalated: true,
      reason: `спор дошёл до оператора и записан для него (не блокирует работу): «${dispute.subject}»`,
    }
  }
  const moved: Dispute = {
    ...dispute,
    level: next,
    deadline: deadlineFor(next, nowMs),
    updatedAt: new Date(nowMs).toISOString(),
  }
  return {
    dispute: moved,
    escalated: true,
    reason: `спор поднялся на уровень ${next}: «${dispute.subject}»`,
  }
}

/** Move an open dispute up only when its time has run out. */
export function escalateDispute(
  dispute: Dispute,
  nowMs: number,
): { dispute: Dispute; escalated: boolean; reason: string } {
  if (!isOverdue(dispute, nowMs)) {
    return { dispute, escalated: false, reason: "время уровня ещё не вышло" }
  }
  return advanceDispute(dispute, nowMs)
}

/** Close an open dispute with a decision. A closed one stays closed. */
export function resolveDispute(dispute: Dispute, decision: string, nowMs: number): Dispute {
  if (dispute.state !== "open") return dispute
  return { ...dispute, state: "resolved", decision, updatedAt: new Date(nowMs).toISOString() }
}
