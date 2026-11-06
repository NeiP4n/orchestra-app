import { describe, expect, test } from "bun:test"
import { Agent } from "@orchestra/schema/agent"
import { Model } from "@orchestra/schema/model"
import { Provider } from "@orchestra/schema/provider"
import type { Dod } from "@orchestra/core/dod"
import { ReviewAcceptance } from "@orchestra/core/review/acceptance"
import { ReviewChecklist } from "@orchestra/core/review/checklist"
import { ReviewDual } from "@orchestra/core/review/dual"
import { ReviewRedTeam } from "@orchestra/core/review/redteam"
import { SessionCompletionGate } from "@orchestra/core/session/completion-gate"
import { SessionMessage } from "@orchestra/core/session/message"
import { DateTime } from "effect"

const time = { created: DateTime.makeUnsafe(0) }
let counter = 0
const id = () => SessionMessage.ID.make(`msg_review_gate_${counter++}`)

const user = (text: string): SessionMessage.Info => ({ type: "user", id: id(), time, text, files: [], agents: [] })

const assistant = (text: string): SessionMessage.Info => ({
  type: "assistant",
  id: id(),
  time,
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("m"), providerID: Provider.ID.make("p") }),
  finish: "stop",
  content: [{ type: "text" as const, text }],
})

// A clean board: nothing the session took is still open, so only the review
// gates can hold the session here.
const cleanBoard: Dod.Status = {
  type: "ready",
  directory: "/project",
  items: [{ id: "L-1", what: "Ship the feature", stage: "build", state: "DONE", done: 3, total: 3, owner: "AI" }],
  steps: new Map([["L-1", ["[x] write code", "[x] add tests", "[x] run checks"]]]),
}

const messages = (): Array<SessionMessage.Info> => [user("ship it"), assistant("Done.")]

const redTeam = (severity: ReviewRedTeam.Severity) => {
  const started = ReviewRedTeam.startReview({ artifactId: "plan-1", artifactKind: "plan", reviewer: "red-team", author: "planner" })
  if (!started.ok) throw new Error(started.message)
  const added = ReviewRedTeam.addFinding(started.value, { severity, summary: "No rollback plan" })
  if (!added.ok) throw new Error(added.message)
  return added.value
}

describe("SessionCompletionGate review gates", () => {
  test("without review records the gate lets a clean session stop", () => {
    expect(SessionCompletionGate.check(messages(), cleanBoard)).toBeUndefined()
  })

  test("an open critical red-team finding blocks completion", () => {
    const nudge = SessionCompletionGate.check(messages(), cleanBoard, undefined, undefined, { redTeam: redTeam("critical") })
    expect(nudge).toContain("Red-team review")
    expect(nudge).toContain("No rollback plan")
  })

  test("an addressed red-team finding does not block", () => {
    const found = redTeam("critical")
    const addressed = ReviewRedTeam.addressFinding(found, found.findings[0].id, "plan updated")
    if (!addressed.ok) throw new Error(addressed.message)
    expect(SessionCompletionGate.check(messages(), cleanBoard, undefined, undefined, { redTeam: addressed.value })).toBeUndefined()
  })

  test("planGate refuses a plan its dual review still blocks", () => {
    const started = ReviewDual.startDualReview({
      artifactId: "arch-1",
      artifactKind: "architecture",
      reviewerA: "group-architects",
      reviewerB: "group-reliability",
      author: "planner",
    })
    if (!started.ok) throw new Error(started.message)
    const add = (review: ReviewRedTeam.Review, reviewer: string) => {
      const added = ReviewRedTeam.addFinding(review, { severity: "major", summary: "No rollback plan", key: "rollback" })
      if (!added.ok) throw new Error(added.message)
      return added.value
    }
    const merged = ReviewDual.merge({ ...started.value, reviewA: add(started.value.reviewA, "a"), reviewB: add(started.value.reviewB, "b") })
    const reason = SessionCompletionGate.planGate({ dual: merged })
    expect(reason).toContain("found by both sides")
    expect(SessionCompletionGate.planGate({})).toBeUndefined()
  })

  test("a failed foreign checklist review blocks completion", () => {
    const started = ReviewChecklist.startChecklist({
      itemId: "L-1",
      itemTitle: "Ship the feature",
      authorGroup: "coders",
      reviewerGroup: "testers",
      steps: ["write code", "add tests"],
    })
    if (!started.ok) throw new Error(started.message)
    const marked = ReviewChecklist.markStep(started.value, 2, "fail", { reason: "test file missing" })
    if (!marked.ok) throw new Error(marked.message)
    const nudge = SessionCompletionGate.check(messages(), cleanBoard, undefined, undefined, { checklist: marked.value })
    expect(nudge).toContain("Checklist review")
    expect(nudge).toContain("test file missing")
  })

  test("an unfinished acceptance run blocks delivery; a deferred one does not", () => {
    const started = ReviewAcceptance.startRun({
      scenario: "Open the app and create a project",
      steps: [{ name: "open app", expected: "The project list loads" }],
    })
    if (!started.ok) throw new Error(started.message)
    const blocked = SessionCompletionGate.check(messages(), cleanBoard, undefined, undefined, { acceptance: started.value })
    expect(blocked).toContain("Acceptance run")
    const deferred = ReviewAcceptance.defer(started.value, "Needs a second device the sandbox has no access to")
    if (!deferred.ok) throw new Error(deferred.message)
    expect(SessionCompletionGate.check(messages(), cleanBoard, undefined, undefined, { acceptance: deferred.value })).toBeUndefined()
  })
})
