export * as ReviewDual from "./dual.js"

import { ReviewRedTeam } from "./redteam.js"

// Dual architecture check (idea #9): the same architecture is reviewed by
// two independent groups that do not know about each other. A hole both
// found is fixed first.
//
// Independence is structural, not a promise: `startDualReview` returns two
// separate review records with separate finding lists and no shared state —
// the second reviewer never sees the first reviewer's findings until
// `merge` runs. What this module cannot enforce is the runtime part: the
// orchestrator must actually run the two reviews in isolated sessions (no
// shared transcript, no cross-talk) and must not show either reviewer the
// other's findings before the merge. A merge of two reviews written by the
// same agent in one session is two copies of one opinion, not a dual check.
//
// Matching: findings match when they carry the same explicit `key`, or when
// their summaries normalize to the same text (case, punctuation and extra
// whitespace ignored). A match is a *candidate* — the merger (an agent at
// runtime, or the orchestrator reading the merged list) confirms it; this
// module only groups and ranks.

export interface DualReview {
  readonly artifactId: string
  readonly artifactKind: ReviewRedTeam.ArtifactKind
  readonly reviewA: ReviewRedTeam.Review
  readonly reviewB: ReviewRedTeam.Review
}

export interface MatchedFinding {
  /** The finding from review A, or undefined when only B found the hole. */
  readonly a?: ReviewRedTeam.Finding
  /** The finding from review B, or undefined when only A found the hole. */
  readonly b?: ReviewRedTeam.Finding
  /** True when both reviews found the same hole. */
  readonly confirmedByBoth: boolean
  /** The highest severity either side gave the hole. */
  readonly severity: ReviewRedTeam.Severity
  readonly summary: string
}

export interface MergedReview {
  readonly artifactId: string
  readonly findings: readonly MatchedFinding[]
  /** Holes both groups found, highest severity first — fix these first. */
  readonly common: readonly MatchedFinding[]
  /** Holes only one group found. */
  readonly onlyOne: readonly MatchedFinding[]
}

/**
 * Opens two independent reviews of the same artifact. The two reviewers must
 * differ from each other and from the artifact's author.
 */
export function startDualReview(input: {
  readonly artifactId: string
  readonly artifactKind: ReviewRedTeam.ArtifactKind
  readonly reviewerA: string
  readonly reviewerB: string
  readonly author?: string
}): ReviewRedTeam.Result<DualReview> {
  const author = input.author?.trim()
  if (input.reviewerA.trim() === input.reviewerB.trim())
    return { ok: false, message: "A dual check needs two different reviewers; both sides named the same one." }
  if (author && (author === input.reviewerA.trim() || author === input.reviewerB.trim()))
    return { ok: false, message: "Neither side of a dual check may be the artifact's author." }
  const a = ReviewRedTeam.startReview({
    artifactId: input.artifactId,
    artifactKind: input.artifactKind,
    reviewer: input.reviewerA,
  })
  if (!a.ok) return a
  const b = ReviewRedTeam.startReview({
    artifactId: input.artifactId,
    artifactKind: input.artifactKind,
    reviewer: input.reviewerB,
  })
  if (!b.ok) return b
  return { ok: true, value: { artifactId: input.artifactId, artifactKind: input.artifactKind, reviewA: a.value, reviewB: b.value } }
}

const severityRank = (severity: ReviewRedTeam.Severity) => ({ critical: 0, major: 1, minor: 2 })[severity]

/** The match key: the reviewer's explicit key when present, else the normalized summary. */
export function matchKey(finding: ReviewRedTeam.Finding): string {
  const key = finding.key?.trim()
  if (key) return `key:${key.toLowerCase()}`
  return `text:${finding.summary.toLowerCase().replace(/[^a-z0-9а-яё]+/giu, " ").replace(/\s+/g, " ").trim()}`
}

/**
 * Merges the two independent reviews. Only OPEN findings merge: an addressed
 * or dismissed finding is already dealt with and never blocks the plan.
 * The merged list is ranked: common findings first (highest severity first),
 * then single-sided findings (highest severity first).
 */
export function merge(dual: DualReview): MergedReview {
  const openA = ReviewRedTeam.openFindings(dual.reviewA)
  const openB = ReviewRedTeam.openFindings(dual.reviewB)
  const byKey = new Map<string, MatchedFinding>()
  const rank = (entry: MatchedFinding) => (entry.confirmedByBoth ? 0 : 1) * 10 + severityRank(entry.severity)
  for (const finding of openA) {
    byKey.set(matchKey(finding), { a: finding, confirmedByBoth: false, severity: finding.severity, summary: finding.summary })
  }
  for (const finding of openB) {
    const key = matchKey(finding)
    const existing = byKey.get(key)
    if (existing === undefined || existing.a === undefined) {
      byKey.set(key, { b: finding, confirmedByBoth: false, severity: finding.severity, summary: finding.summary })
      continue
    }
    byKey.set(key, {
      a: existing.a,
      b: finding,
      confirmedByBoth: true,
      severity: severityRank(existing.severity) <= severityRank(finding.severity) ? existing.severity : finding.severity,
      summary: existing.summary,
    })
  }
  const findings = [...byKey.values()].sort((left, right) => rank(left) - rank(right))
  return {
    artifactId: dual.artifactId,
    findings,
    common: findings.filter((entry) => entry.confirmedByBoth),
    onlyOne: findings.filter((entry) => !entry.confirmedByBoth),
  }
}

/** Open findings that block the plan: any common finding, or any single-sided critical/major one. */
export function blockingFindings(merged: MergedReview): readonly MatchedFinding[] {
  return merged.findings.filter(
    (entry) => entry.confirmedByBoth || entry.severity !== "minor",
  )
}

/** The architecture may proceed only when nothing blocks it. */
export function canProceed(merged: MergedReview): boolean {
  return blockingFindings(merged).length === 0
}

export function summary(merged: MergedReview): string {
  return [
    `Dual review of ${JSON.stringify(merged.artifactId)}: ${merged.findings.length} open hole(s) — ${merged.common.length} found by both sides, ${merged.onlyOne.length} by one side only.`,
    ...(blockingFindings(merged).length > 0
      ? [
          `Blocking, fix first: ${blockingFindings(merged).map((entry) => `${entry.severity}${entry.confirmedByBoth ? " (both sides)" : ""} "${entry.summary}"`).join("; ")}`,
        ]
      : ["Nothing blocking."]),
  ].join("\n")
}
