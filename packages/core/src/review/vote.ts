export * as ReviewVote from "./vote.js"

// Evidence-weighted voting (idea #5): a vote weighs more when a test or a
// measurement is attached to it, not an opinion. A disputed decision is
// settled by a jury of three random agents — by evidence as well.
//
// This module is the MECHANISM. It records votes, weighs them, counts them,
// and picks the jury. It does not decide what is true: the votes and the
// evidence are written at runtime by the voting agents, and the tally only
// adds up what they attached.
//
// Rules:
// - weight: base 1, plus the best attached evidence — a test or a
//   measurement +2, a document +1, an opinion +0. Only the best evidence
//   counts, so attaching five documents never outvotes one test;
// - one vote per voter: a re-vote replaces the earlier one, and the record
//   keeps the latest only;
// - the jury is three agents drawn with a SEEDED random generator from the
//   candidates minus the interested parties; the same seed replays the same
//   jury, and a jury with an interested member in it is refused;
// - a jury decision needs all three jurors' votes; anything less is pending,
//   never a majority of two.
//
// Hook point (honest limitation): Orchestra has NO decision stream to wire
// this into. The council (`packages/core/src/federation.ts`,
// `consultGroup`) is consult-only by design — proposals are data, no
// project's vote is binding and none authorizes work in another project
// (`packages/core/src/plugin/agent.ts`). So this module stands alone: the
// council synthesis reads a `tally`/`decide` record when the operator or
// the council asks for a vote, and the record is the decision. Wiring a
// binding vote into federation would change product policy (votes becoming
// binding), which this slice does not do.

export const EvidenceKind = ["test", "measurement", "document", "opinion"] as const
export type EvidenceKind = (typeof EvidenceKind)[number]

/** The best attached evidence decides the bonus: test/measurement +2, document +1, opinion +0. */
export const EVIDENCE_BONUS: Record<EvidenceKind, number> = { test: 2, measurement: 2, document: 1, opinion: 0 }

export interface Evidence {
  readonly kind: EvidenceKind
  /** What the evidence is: a test name, a command and its output, a file:line. */
  readonly ref: string
}

export const Position = ["for", "against", "abstain"] as const
export type Position = (typeof Position)[number]

export interface Vote {
  readonly voter: string
  readonly position: Position
  readonly evidence: readonly Evidence[]
  /** Computed from the evidence at cast time: 1 + best bonus. */
  readonly weight: number
  readonly at: number
}

export interface Ballot {
  readonly id: string
  readonly question: string
  readonly votes: readonly Vote[]
  readonly createdAt: number
}

export interface Tally {
  readonly for: number
  readonly against: number
  readonly abstain: number
  readonly totalWeight: number
  readonly votes: number
  readonly winner: "for" | "against" | "tie" | "none"
}

export interface Decision {
  readonly ballotId: string
  readonly question: string
  readonly tally: Tally
  /** The jury that decided, when one was used. */
  readonly jury?: readonly string[]
  readonly outcome: string
  readonly decidedAt: number
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (message: string): Result<never> => ({ ok: false, message })

let counter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

export function weightOf(evidence: readonly Evidence[]): number {
  return 1 + Math.max(0, ...evidence.map((entry) => EVIDENCE_BONUS[entry.kind] ?? 0))
}

/** Opens a ballot on one question. */
export function openBallot(input: { readonly id?: string; readonly question: string }): Result<Ballot> {
  if (!input.question.trim()) return fail("A ballot needs the question it votes on.")
  return ok({ id: input.id?.trim() || nextId("ballot"), question: input.question.trim(), votes: [], createdAt: Date.now() })
}

/**
 * Casts a vote. One vote per voter: a re-vote replaces the earlier one.
 * Evidence with an empty reference is refused — a claimed test that points
 * nowhere weighs nothing.
 */
export function castVote(
  ballot: Ballot,
  input: { readonly voter: string; readonly position: Position; readonly evidence?: readonly Evidence[] },
): Result<Ballot> {
  const voter = input.voter.trim()
  if (!voter) return fail("A vote needs a voter.")
  if (!Position.includes(input.position)) return fail(`Unknown position ${JSON.stringify(input.position)}.`)
  const evidence = input.evidence ?? []
  for (const entry of evidence) {
    if (!EvidenceKind.includes(entry.kind)) return fail(`Unknown evidence kind ${JSON.stringify(entry.kind)}.`)
    if (!entry.ref.trim()) return fail("Evidence needs a reference: a test or measurement that points nowhere weighs nothing.")
  }
  const vote: Vote = { voter, position: input.position, evidence, weight: weightOf(evidence), at: Date.now() }
  const index = ballot.votes.findIndex((entry) => entry.voter === voter)
  const votes = index < 0 ? [...ballot.votes, vote] : ballot.votes.with(index, vote)
  return ok({ ...ballot, votes })
}

/** Weighted count. Abstentions weigh in the total but never win. */
export function tally(ballot: Ballot): Tally {
  const sum = (position: Position) =>
    ballot.votes.filter((vote) => vote.position === position).reduce((total, vote) => total + vote.weight, 0)
  const forWeight = sum("for")
  const againstWeight = sum("against")
  return {
    for: forWeight,
    against: againstWeight,
    abstain: sum("abstain"),
    totalWeight: ballot.votes.reduce((total, vote) => total + vote.weight, 0),
    votes: ballot.votes.length,
    winner: ballot.votes.length === 0 ? "none" : forWeight === againstWeight ? "tie" : forWeight > againstWeight ? "for" : "against",
  }
}

/** Seeded PRNG (mulberry32): the same seed replays the same jury. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Picks a jury of three from the candidates, excluding everyone interested in
 * the outcome. Refused when fewer than three eligible agents remain — a jury
 * of two is not a jury.
 */
export function selectJury(input: {
  readonly candidates: readonly string[]
  readonly interested?: readonly string[]
  readonly seed: number
}): Result<readonly string[]> {
  const interested = new Set((input.interested ?? []).map((name) => name.trim()))
  const eligible = [...new Set(input.candidates.map((name) => name.trim()).filter(Boolean))].filter(
    (name) => !interested.has(name),
  )
  if (eligible.length < 3)
    return fail(
      `A jury needs three eligible agents; only ${eligible.length} remain after excluding the interested parties.`,
    )
  const random = seededRandom(input.seed)
  const pool = [...eligible]
  for (let index = pool.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[pool[index], pool[swap]] = [pool[swap], pool[index]]
  }
  return ok(pool.slice(0, 3))
}

/**
 * Settles the ballot. With a jury, the decision is the jury's tally — and it
 * needs all three jurors' votes; a jury that has not fully voted leaves the
 * decision pending. Without a jury, the decision is the full ballot's tally;
 * a tie is recorded as a tie, never silently broken.
 */
export function decide(ballot: Ballot, input?: { readonly jury?: readonly string[] }): Result<Decision> {
  const jury = input?.jury
  if (jury !== undefined) {
    if (jury.length !== 3) return fail(`A jury has exactly three members; ${jury.length} were given.`)
    const missing = jury.filter((member) => !ballot.votes.some((vote) => vote.voter === member))
    if (missing.length > 0)
      return fail(`The jury has not decided yet: ${missing.join(", ")} still owe${missing.length === 1 ? "s" : ""} a vote.`)
    const juryBallot: Ballot = { ...ballot, votes: ballot.votes.filter((vote) => jury.includes(vote.voter)) }
    const counted = tally(juryBallot)
    return ok({
      ballotId: ballot.id,
      question: ballot.question,
      tally: counted,
      jury: [...jury],
      outcome:
        counted.winner === "none" || counted.winner === "tie"
          ? `Jury deadlocked (${counted.for} for, ${counted.against} against, weighted) — escalate, do not guess.`
          : `Jury decided ${counted.winner} (${counted.for} for, ${counted.against} against, weighted).`,
      decidedAt: Date.now(),
    })
  }
  const counted = tally(ballot)
  return ok({
    ballotId: ballot.id,
    question: ballot.question,
    tally: counted,
    outcome:
      counted.winner === "none"
        ? "No votes cast — nothing decided."
        : counted.winner === "tie"
          ? `Tied (${counted.for} for, ${counted.against} against, weighted) — escalate, do not guess.`
          : `Decided ${counted.winner} (${counted.for} for, ${counted.against} against, weighted).`,
    decidedAt: Date.now(),
  })
}

export function summary(decision: Decision): string {
  return [
    `Decision on "${decision.question}": ${decision.outcome}`,
    ...(decision.jury ? [`Jury: ${decision.jury.join(", ")}.`] : []),
    `Weighted tally: ${decision.tally.for} for, ${decision.tally.against} against, ${decision.tally.abstain} abstain (${decision.tally.votes} votes).`,
  ].join("\n")
}
