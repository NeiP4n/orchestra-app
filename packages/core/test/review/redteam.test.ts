import { describe, expect, test } from "bun:test"
import { ReviewRedTeam } from "@orchestra/core/review/redteam"

const review = () => {
  const started = ReviewRedTeam.startReview({ artifactId: "plan-1", artifactKind: "plan", reviewer: "red-team", author: "planner" })
  if (!started.ok) throw new Error(started.message)
  return started.value
}

const withFinding = (severity: ReviewRedTeam.Severity, summary: string) => {
  const added = ReviewRedTeam.addFinding(review(), { severity, summary })
  if (!added.ok) throw new Error(added.message)
  return added.value
}

describe("ReviewRedTeam", () => {
  test("refuses a review where the reviewer also wrote the artifact", () => {
    const started = ReviewRedTeam.startReview({ artifactId: "plan-1", artifactKind: "plan", reviewer: "planner", author: "planner" })
    expect(started.ok).toBe(false)
  })

  test("a critical finding blocks the plan until addressed", () => {
    const found = withFinding("critical", "Auth token is logged in plain text")
    expect(ReviewRedTeam.canProceed(found)).toBe(false)
    expect(ReviewRedTeam.blockingFindings(found)).toHaveLength(1)
    const addressed = ReviewRedTeam.addressFinding(found, found.findings[0].id, "commit abc: token redacted")
    if (!addressed.ok) throw new Error(addressed.message)
    expect(ReviewRedTeam.canProceed(addressed.value)).toBe(true)
    expect(ReviewRedTeam.isClear(addressed.value)).toBe(true)
  })

  test("a minor finding is recorded but never blocks", () => {
    const found = withFinding("minor", "Typo in the section title")
    expect(ReviewRedTeam.canProceed(found)).toBe(true)
    expect(ReviewRedTeam.isClear(found)).toBe(false)
  })

  test("dismissal without a reason is refused", () => {
    const found = withFinding("major", "No rollback plan")
    const dismissed = ReviewRedTeam.dismissFinding(found, found.findings[0].id, "  ")
    expect(dismissed.ok).toBe(false)
    expect(ReviewRedTeam.canProceed(found)).toBe(false)
  })

  test("dismissal with a reason unblocks", () => {
    const found = withFinding("major", "No rollback plan")
    const dismissed = ReviewRedTeam.dismissFinding(found, found.findings[0].id, "Single-node dev install; rollback is a reinstall")
    if (!dismissed.ok) throw new Error(dismissed.message)
    expect(ReviewRedTeam.canProceed(dismissed.value)).toBe(true)
    expect(dismissed.value.findings[0].status).toBe("dismissed")
  })

  test("addressing an unknown finding fails", () => {
    const addressed = ReviewRedTeam.addressFinding(review(), "finding-nope", "commit abc")
    expect(addressed.ok).toBe(false)
  })

  test("summary names the blocking findings", () => {
    const found = withFinding("critical", "Auth token is logged in plain text")
    expect(ReviewRedTeam.summary(found)).toContain("Blocking")
    expect(ReviewRedTeam.summary(found)).toContain("Auth token is logged in plain text")
  })
})
