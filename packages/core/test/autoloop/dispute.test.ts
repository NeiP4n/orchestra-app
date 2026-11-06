import { describe, expect, test } from "bun:test"
import { SessionEscalate } from "@orchestra/core/session/runner/escalate"
import {
  DISPUTE_LEVELS,
  DISPUTE_TIMEOUT_MINUTES,
  advanceDispute,
  deadlineFor,
  escalateDispute,
  isOverdue,
  nextLevel,
  resolveDispute,
  type Dispute,
} from "@orchestra/core/autoloop/kernel/dispute"

const T0 = Date.parse("2026-11-05T21:00:00.000Z")
const MINUTE = 60_000

const open = (overrides: Partial<Dispute> = {}): Dispute => ({
  id: 1,
  subject: "какой формат хранить",
  positionA: "хранить как JSON",
  positionB: "хранить как YAML",
  level: "agent",
  deadline: deadlineFor("agent", T0),
  state: "open",
  decision: null,
  createdAt: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
  ...overrides,
})

describe("AutoloopDispute ladder", () => {
  test("the rungs climb agent → group-leader → council → orchestrator → operator", () => {
    expect(DISPUTE_LEVELS).toEqual(["agent", "group-leader", "council", "orchestrator", "operator"])
    expect(nextLevel("agent")).toBe("group-leader")
    expect(nextLevel("council")).toBe("orchestrator")
    expect(nextLevel("operator")).toBeNull()
  })

  test("each level has its deadline; the operator has none", () => {
    expect(DISPUTE_TIMEOUT_MINUTES).toEqual({ agent: 15, "group-leader": 30, council: 60, orchestrator: 120 })
    expect(deadlineFor("agent", T0)).toBe(new Date(T0 + 15 * MINUTE).toISOString())
    expect(deadlineFor("council", T0)).toBe(new Date(T0 + 60 * MINUTE).toISOString())
    expect(deadlineFor("operator", T0)).toBe("")
  })

  test("an overdue dispute moves up one level with a fresh deadline and both positions", () => {
    const moved = escalateDispute(open(), T0 + 16 * MINUTE)
    expect(moved.escalated).toBe(true)
    expect(moved.dispute.level).toBe("group-leader")
    expect(moved.dispute.deadline).toBe(new Date(T0 + 16 * MINUTE + 30 * MINUTE).toISOString())
    expect(moved.dispute.positionA).toBe("хранить как JSON")
    expect(moved.dispute.positionB).toBe("хранить как YAML")
    expect(moved.dispute.state).toBe("open")
  })

  test("a dispute inside its time does not move", () => {
    const kept = escalateDispute(open(), T0 + 14 * MINUTE)
    expect(kept.escalated).toBe(false)
    expect(kept.dispute.level).toBe("agent")
    expect(isOverdue(open(), T0 + 14 * MINUTE)).toBe(false)
    expect(isOverdue(open(), T0 + 15 * MINUTE)).toBe(true)
  })

  test("climbing past the orchestrator records the dispute for the operator instead of waiting", () => {
    const atOperator = advanceDispute(open({ level: "orchestrator", deadline: deadlineFor("orchestrator", T0) }), T0)
    expect(atOperator.escalated).toBe(true)
    expect(atOperator.dispute.level).toBe("operator")
    expect(atOperator.dispute.state).toBe("noted")
    expect(atOperator.dispute.deadline).toBe("")
    expect(atOperator.reason).toContain("записан для него")
  })

  test("a noted dispute does not move again, and a resolved one does not either", () => {
    const noted = advanceDispute(open({ level: "orchestrator" }), T0).dispute
    expect(escalateDispute(noted, T0 + 10 * 60 * MINUTE).escalated).toBe(false)
    const resolved = resolveDispute(open(), "берём JSON", T0 + MINUTE)
    expect(resolved.state).toBe("resolved")
    expect(resolved.decision).toBe("берём JSON")
    expect(advanceDispute(resolved, T0 + MINUTE).escalated).toBe(false)
    expect(resolveDispute(resolved, "передумали", T0 + 2 * MINUTE).decision).toBe("берём JSON")
  })

  test("the session runner re-exports the same ladder", () => {
    expect(SessionEscalate.DisputeLadder.DISPUTE_TIMEOUT_MINUTES.agent).toBe(15)
    expect(SessionEscalate.DisputeLadder.nextLevel("agent")).toBe("group-leader")
  })
})
