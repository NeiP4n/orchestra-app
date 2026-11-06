import { describe, expect, test } from "bun:test"
import { ReviewAcceptance } from "@orchestra/core/review/acceptance"

const run = () => {
  const started = ReviewAcceptance.startRun({
    scenario: "Open the app, create a project, invite a member",
    steps: [
      { name: "open app", expected: "The project list loads" },
      { name: "create project", expected: "The new project appears in the list" },
      { name: "invite member", expected: "The member sees the project" },
    ],
  })
  if (!started.ok) throw new Error(started.message)
  return started.value
}

describe("ReviewAcceptance", () => {
  test("delivery is blocked while steps are pending", () => {
    expect(ReviewAcceptance.mayShip(run())).toBe(false)
    expect(ReviewAcceptance.blockingReason(run())).toContain("still pending")
  })

  test("the run passes only when every step passed", () => {
    let current = run()
    for (const step of current.steps) {
      const recorded = ReviewAcceptance.recordStep(current, step.name, "pass", { evidence: "saw it in the running app" })
      if (!recorded.ok) throw new Error(recorded.message)
      current = recorded.value
    }
    expect(current.status).toBe("passed")
    expect(ReviewAcceptance.mayShip(current)).toBe(true)
  })

  test("one failed step fails the whole run and needs a reason", () => {
    const current = run()
    const noReason = ReviewAcceptance.recordStep(current, "invite member", "fail")
    expect(noReason.ok).toBe(false)
    const recorded = ReviewAcceptance.recordStep(current, "invite member", "fail", {
      reason: "Invite button does nothing",
      evidence: "clicked twice, no network request",
    })
    if (!recorded.ok) throw new Error(recorded.message)
    expect(recorded.value.status).toBe("failed")
    expect(ReviewAcceptance.mayShip(recorded.value)).toBe(false)
    expect(ReviewAcceptance.blockingReason(recorded.value)).toContain("Invite button does nothing")
  })

  test("deferral without a reason is refused; with a reason it unblocks but stays deferred", () => {
    const current = run()
    expect(ReviewAcceptance.defer(current, "  ").ok).toBe(false)
    const deferred = ReviewAcceptance.defer(current, "The scenario needs a second device the sandbox has no access to")
    if (!deferred.ok) throw new Error(deferred.message)
    expect(deferred.value.status).toBe("deferred")
    expect(ReviewAcceptance.mayShip(deferred.value)).toBe(true)
    expect(ReviewAcceptance.summary(deferred.value)).toContain("Deferred")
  })

  test("a passed run is never deferred", () => {
    let current = run()
    for (const step of current.steps) {
      const recorded = ReviewAcceptance.recordStep(current, step.name, "pass")
      if (!recorded.ok) throw new Error(recorded.message)
      current = recorded.value
    }
    expect(ReviewAcceptance.defer(current, "changed my mind").ok).toBe(false)
  })

  test("a run with no steps is refused", () => {
    expect(ReviewAcceptance.startRun({ scenario: "Do the thing", steps: [] }).ok).toBe(false)
  })
})
