import { describe, expect, test } from "bun:test"
import type { Dod } from "@orchestra/core/dod"
import { ReviewChecklist } from "@orchestra/core/review/checklist"

const board: Dod.Status = {
  type: "ready",
  directory: "/project",
  items: [{ id: "L-1", what: "Ship the feature", stage: "build", state: "IN_PROGRESS", done: 3, total: 3, owner: "coders" }],
  steps: new Map([["L-1", ["[x] write code", "[x] add tests", "[x] run checks"]]]),
}

const checklist = () => {
  const started = ReviewChecklist.fromDod(board, "L-1", { authorGroup: "coders", reviewerGroup: "testers" })
  if (!started.ok) throw new Error(started.message)
  return started.value
}

describe("ReviewChecklist", () => {
  test("assignReviewer picks a group that did not do the work", () => {
    const assigned = ReviewChecklist.assignReviewer({ authorGroup: "coders", groups: ["coders", "testers", "architects"] })
    if (!assigned.ok) throw new Error(assigned.message)
    expect(assigned.value.reviewerGroup).toBe("testers")
  })

  test("assignReviewer fails when no foreign group exists", () => {
    expect(ReviewChecklist.assignReviewer({ authorGroup: "coders", groups: ["coders"] }).ok).toBe(false)
  })

  test("fromDod builds the checklist from the board's step lines", () => {
    const review = checklist()
    expect(review.steps).toHaveLength(3)
    expect(review.steps[0].text).toContain("write code")
    expect(ReviewChecklist.verdict(review)).toBe("pending")
  })

  test("fromDod refuses the author's own group as reviewer", () => {
    const started = ReviewChecklist.fromDod(board, "L-1", { authorGroup: "coders", reviewerGroup: "coders" })
    expect(started.ok).toBe(false)
  })

  test("fromDod fails on a board that is not ready", () => {
    const started = ReviewChecklist.fromDod({ type: "disabled", directory: "/project" }, "L-1", {
      authorGroup: "coders",
      reviewerGroup: "testers",
    })
    expect(started.ok).toBe(false)
  })

  test("verdict is pass only when every step passed", () => {
    let review = checklist()
    for (const step of review.steps) {
      const marked = ReviewChecklist.markStep(review, step.index, "pass", { evidence: "bun test green" })
      if (!marked.ok) throw new Error(marked.message)
      review = marked.value
    }
    expect(ReviewChecklist.verdict(review)).toBe("pass")
  })

  test("one failed step fails the whole review and needs a reason", () => {
    const review = checklist()
    const noReason = ReviewChecklist.markStep(review, 2, "fail")
    expect(noReason.ok).toBe(false)
    const marked = ReviewChecklist.markStep(review, 2, "fail", { reason: "test file missing" })
    if (!marked.ok) throw new Error(marked.message)
    expect(ReviewChecklist.verdict(marked.value)).toBe("fail")
    expect(ReviewChecklist.failedSteps(marked.value)).toHaveLength(1)
  })
})
