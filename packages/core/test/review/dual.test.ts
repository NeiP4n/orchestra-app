import { describe, expect, test } from "bun:test"
import { ReviewDual } from "@orchestra/core/review/dual"
import { ReviewRedTeam } from "@orchestra/core/review/redteam"

const dual = () => {
  const started = ReviewDual.startDualReview({
    artifactId: "arch-1",
    artifactKind: "architecture",
    reviewerA: "group-architects",
    reviewerB: "group-reliability",
    author: "planner",
  })
  if (!started.ok) throw new Error(started.message)
  return started.value
}

const add = (review: ReviewRedTeam.Review, severity: ReviewRedTeam.Severity, summary: string, key?: string) => {
  const added = ReviewRedTeam.addFinding(review, { severity, summary, ...(key ? { key } : {}) })
  if (!added.ok) throw new Error(added.message)
  return added.value
}

describe("ReviewDual", () => {
  test("refuses two sides naming the same reviewer", () => {
    const started = ReviewDual.startDualReview({
      artifactId: "arch-1",
      artifactKind: "architecture",
      reviewerA: "same-group",
      reviewerB: "same-group",
    })
    expect(started.ok).toBe(false)
  })

  test("the two reviews are independent records with separate findings", () => {
    const started = dual()
    expect(started.reviewA.id).not.toBe(started.reviewB.id)
    const withA = { ...started, reviewA: add(started.reviewA, "major", "Only A saw this") }
    expect(withA.reviewB.findings).toHaveLength(0)
    expect(ReviewDual.merge(withA).onlyOne).toHaveLength(1)
  })

  test("a hole both sides found is common and ranks first", () => {
    const started = dual()
    const merged = ReviewDual.merge({
      ...started,
      reviewA: add(started.reviewA, "major", "No rollback plan", "rollback"),
      reviewB: add(started.reviewB, "critical", "No rollback plan", "rollback"),
    })
    expect(merged.common).toHaveLength(1)
    expect(merged.common[0].confirmedByBoth).toBe(true)
    expect(merged.common[0].severity).toBe("critical")
    expect(merged.findings[0]).toBe(merged.common[0])
    expect(ReviewDual.canProceed(merged)).toBe(false)
  })

  test("matching also works on normalized summary text without an explicit key", () => {
    const started = dual()
    const merged = ReviewDual.merge({
      ...started,
      reviewA: add(started.reviewA, "minor", "  Auth token  logged in plain text. "),
      reviewB: add(started.reviewB, "minor", "auth token logged in plain text"),
    })
    expect(merged.common).toHaveLength(1)
  })

  test("addressed findings never merge: only open holes block", () => {
    const started = dual()
    const reviewA = add(started.reviewA, "critical", "No rollback plan", "rollback")
    const addressed = ReviewRedTeam.addressFinding(reviewA, reviewA.findings[0].id, "plan updated")
    if (!addressed.ok) throw new Error(addressed.message)
    const merged = ReviewDual.merge({ ...started, reviewA: addressed.value })
    expect(merged.findings).toHaveLength(0)
    expect(ReviewDual.canProceed(merged)).toBe(true)
  })

  test("a single-sided minor finding does not block", () => {
    const started = dual()
    const merged = ReviewDual.merge({ ...started, reviewA: add(started.reviewA, "minor", "Typo in a diagram") })
    expect(ReviewDual.canProceed(merged)).toBe(true)
    expect(merged.onlyOne).toHaveLength(1)
  })
})
