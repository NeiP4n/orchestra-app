export * as ReviewRedTeam from "./redteam.js"

import { Schema } from "effect"

// Red-team review (idea #1): one group or agent plays against the rest —
// it hunts for holes in a plan or architecture and argues with it BEFORE
// any code is written, not after.
//
// This module is the MECHANISM, not the review itself. The review content
// (the findings, the arguments) is written at runtime by the reviewer agent;
// this module is the record and the rules around it:
// - every finding is recorded with a severity and stays open until it is
//   addressed or explicitly dismissed WITH a reason;
// - a plan or architecture may proceed only when no open critical or major
//   finding remains (minor findings may stay open, recorded, but they never
//   block on their own);
// - dismissal without a reason is refused, so a hole can never be waved
//   away silently.
//
// The module is pure: no Effect, no I/O, no model calls. Persistence (KV,
// journal) and the runtime prompt that tells the reviewer what to attack
// live outside it. The dual architecture check (`dual.ts`) and the plan
// acceptance gate (`session/completion-gate.ts`, `planGate`) reuse this
// record instead of inventing their own.

export const Severity = Schema.Literals(["critical", "major", "minor"])
export type Severity = Schema.Schema.Type<typeof Severity>
export const SEVERITIES: readonly Severity[] = [...Severity.literals]

export const ArtifactKind = Schema.Literals(["plan", "architecture"])
export type ArtifactKind = Schema.Schema.Type<typeof ArtifactKind>

export const FindingStatus = Schema.Literals(["open", "addressed", "dismissed"])
export type FindingStatus = Schema.Schema.Type<typeof FindingStatus>

export const Finding = Schema.Struct({
  id: Schema.String,
  reviewId: Schema.String,
  severity: Severity,
  summary: Schema.String,
  /** Where in the artifact the hole is: a section name, file, or test reference. */
  evidence: Schema.optionalKey(Schema.String),
  /**
   * Short stable key the reviewer supplies when two findings are the same hole
   * (e.g. "auth-token-leak"). The dual review (`dual.ts`) matches findings by
   * this key first, and by normalized summary otherwise. Optional: a review
   * with a single reviewer never needs it.
   */
  key: Schema.optionalKey(Schema.String),
  status: FindingStatus,
  /** What fixed it: a commit, a plan change, a test — a reference, never prose. */
  addressedBy: Schema.optionalKey(Schema.String),
  /** Why the finding was rejected. Required when status is "dismissed". */
  dismissedReason: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
})
export type Finding = Schema.Schema.Type<typeof Finding>

export const Review = Schema.Struct({
  id: Schema.String,
  artifactId: Schema.String,
  artifactKind: ArtifactKind,
  /** The group or agent that reviewed — never the group that wrote the artifact. */
  reviewer: Schema.String,
  findings: Schema.Array(Finding),
  createdAt: Schema.Number,
})
export type Review = Schema.Schema.Type<typeof Review>

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (message: string): Result<never> => ({ ok: false, message })

let counter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

export interface StartReviewInput {
  readonly id?: string
  readonly artifactId: string
  readonly artifactKind: ArtifactKind
  /** The reviewing group or agent. Must differ from the artifact's author — the caller checks that; this module records both names. */
  readonly reviewer: string
  readonly author?: string
}

/** Opens a review of a plan or architecture artifact. The artifact itself is not stored here — only its id. */
export function startReview(input: StartReviewInput): Result<Review> {
  if (!input.artifactId.trim()) return fail("A red-team review needs the id of the plan or architecture it reviews.")
  if (!input.reviewer.trim()) return fail("A red-team review needs a reviewer.")
  if (input.author !== undefined && input.author.trim() !== "" && input.author.trim() === input.reviewer.trim())
    return fail(`The red team cannot be its own author: reviewer ${JSON.stringify(input.reviewer)} also wrote the artifact.`)
  return ok({
    id: input.id?.trim() || nextId("review"),
    artifactId: input.artifactId.trim(),
    artifactKind: input.artifactKind,
    reviewer: input.reviewer.trim(),
    findings: [],
    createdAt: Date.now(),
  })
}

export interface AddFindingInput {
  readonly id?: string
  readonly severity: Severity
  readonly summary: string
  readonly evidence?: string
  readonly key?: string
}

/** Records one hole the red team found. The summary is the hole; evidence points at where it is. */
export function addFinding(review: Review, input: AddFindingInput): Result<Review> {
  if (!input.summary.trim()) return fail("A finding needs a summary of the hole it reports.")
  if (!SEVERITIES.includes(input.severity)) return fail(`Unknown severity ${JSON.stringify(input.severity)}.`)
  const finding: Finding = {
    id: input.id?.trim() || nextId("finding"),
    reviewId: review.id,
    severity: input.severity,
    summary: input.summary.trim(),
    ...(input.evidence?.trim() ? { evidence: input.evidence.trim() } : {}),
    ...(input.key?.trim() ? { key: input.key.trim() } : {}),
    status: "open",
    createdAt: Date.now(),
  }
  if (review.findings.some((entry) => entry.id === finding.id))
    return fail(`Review ${review.id} already has a finding ${finding.id}.`)
  return ok({ ...review, findings: [...review.findings, finding] })
}

/** Marks a finding fixed, with a reference to what fixed it (a commit, a plan change, a test). */
export function addressFinding(review: Review, findingId: string, addressedBy: string): Result<Review> {
  if (!addressedBy.trim()) return fail("Addressing a finding needs a reference to what fixed it.")
  return updateFinding(review, findingId, (finding) =>
    finding.status === "open"
      ? { ...finding, status: "addressed" as const, addressedBy: addressedBy.trim() }
      : undefined,
  )
}

/**
 * Rejects a finding — but only with a reason. A dismissal without a reason is
 * refused: a hole may be judged not-a-hole, never waved away silently.
 */
export function dismissFinding(review: Review, findingId: string, reason: string): Result<Review> {
  if (!reason.trim()) return fail("Dismissing a finding needs a reason: a hole is never waved away silently.")
  return updateFinding(review, findingId, (finding) =>
    finding.status === "open"
      ? { ...finding, status: "dismissed" as const, dismissedReason: reason.trim() }
      : undefined,
  )
}

function updateFinding(
  review: Review,
  findingId: string,
  update: (finding: Finding) => Finding | undefined,
): Result<Review> {
  const index = review.findings.findIndex((finding) => finding.id === findingId)
  if (index < 0) return fail(`Review ${review.id} has no finding ${findingId}.`)
  const updated = update(review.findings[index])
  if (updated === undefined) return fail(`Finding ${findingId} is already ${review.findings[index].status}; only an open finding moves.`)
  return ok({ ...review, findings: review.findings.with(index, updated) })
}

/** Findings still open, in the order they were recorded. */
export function openFindings(review: Review): readonly Finding[] {
  return review.findings.filter((finding) => finding.status === "open")
}

/**
 * Open findings that block the plan: critical and major. Minor findings are
 * recorded and visible, but they never block on their own.
 */
export function blockingFindings(review: Review): readonly Finding[] {
  return openFindings(review).filter((finding) => finding.severity !== "minor")
}

/** The plan may proceed only when no open critical or major finding remains. */
export function canProceed(review: Review): boolean {
  return blockingFindings(review).length === 0
}

/** True when nothing is open at all — no finding left unaddressed, not even a minor one. */
export function isClear(review: Review): boolean {
  return openFindings(review).length === 0
}

/** One line per finding, for the gate reminder and the review record. */
export function summary(review: Review): string {
  const counts = (status: FindingStatus) => review.findings.filter((finding) => finding.status === status).length
  return [
    `Red-team review ${review.id} of ${review.artifactKind} ${JSON.stringify(review.artifactId)} by ${review.reviewer}:`,
    `${review.findings.length} finding(s) — ${counts("open")} open, ${counts("addressed")} addressed, ${counts("dismissed")} dismissed.`,
    ...(blockingFindings(review).length > 0
      ? [`Blocking: ${blockingFindings(review).map((finding) => `${finding.severity} "${finding.summary}"`).join("; ")}`]
      : ["Nothing blocking."]),
  ].join("\n")
}
