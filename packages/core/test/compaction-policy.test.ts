import { describe, expect, test } from "bun:test"
import { Orchestra } from "@orchestra/schema/orchestra"
import { CompactionPolicy } from "@orchestra/core/session/compaction-policy"
import { SessionPlan } from "@orchestra/core/session/plan"
import { resolveSessionThreshold } from "@orchestra/core/session/compaction"

// The plan's table: analysis, architecture and review keep the longest working memory, testing and
// debugging compact first because their logs burn context, everything else sits in the middle.
const deep = [
  "analyst",
  "product-analyst",
  "architect",
  "strategic-planner",
  "researcher",
  "deep-researcher",
  "designer",
  "reviewer",
  "counterexample-engineer",
  "security-auditor",
  "compatibility-engineer",
]
const lean = ["tester", "debugger", "performance-engineer"]
const standard = [
  "developer",
  "frontend-developer",
  "backend-developer",
  "mobile-developer",
  "desktop-developer",
  "core-maintainer",
  "devops",
  "writer",
  "database-engineer",
  "data-migration-engineer",
  "generalist",
  "fallback",
]

const thresholdFor = (id: string) =>
  deep.includes(id)
    ? CompactionPolicy.deepThreshold
    : lean.includes(id)
      ? CompactionPolicy.leanThreshold
      : CompactionPolicy.standardThreshold

// Shipped roster roles the plan's table does not name. They keep the
// standard middle by rule, and each one is listed here explicitly so a new
// role can never drift into an unpinned tier: extending the roster requires
// assigning the new role to a tier in this test.
const unnamedStandard = [
  "accessibility-auditor",
  "dependency-auditor",
  "reliability-engineer",
  "integration-engineer",
  "api-contract-engineer",
  "game-designer",
  "marketer",
  "system-administrator",
  "support-engineer",
  "team-planner",
  "ideator-a",
  "ideator-b",
  "team-solver",
  "team-manager",
  "repairer",
]

describe("CompactionPolicy", () => {
  test("the roster covers the policy table", () => {
    const ids = Orchestra.roles.map((role) => role.id)
    // "analyst" and "fallback" are policy names for work the roster spells differently or does not
    // ship as a role at all, so they are checked against roleThreshold directly below.
    expect(ids).toEqual(expect.arrayContaining([...deep.filter((id) => id !== "analyst"), ...lean]))
    expect(ids).toEqual(expect.arrayContaining(standard.filter((id) => id !== "fallback")))
    // Coverage is derived from the actual shipped roster, not a count: every
    // shipped role appears in exactly one tier list (named or unnamed).
    const named = new Set([...deep, ...lean, ...standard, ...unnamedStandard])
    for (const id of ids) expect(named.has(id), `role ${id} has no pinned tier`).toBe(true)
    for (const id of unnamedStandard) expect(ids, `pinned role ${id} is not shipped`).toContain(id)
  })

  test("every shipped role lands on its tier", () => {
    for (const role of Orchestra.roles) {
      const expected = unnamedStandard.includes(role.id) ? CompactionPolicy.standardThreshold : thresholdFor(role.id)
      expect(CompactionPolicy.roleThreshold(role), `role ${role.id}`).toEqual(expected)
    }
    // The unnamed middle is asserted role by role, so each of these roles is
    // pinned to the standard tier by an explicit decision here.
    for (const id of unnamedStandard) {
      expect(CompactionPolicy.roleThreshold({ id }), `role ${id}`).toEqual(CompactionPolicy.standardThreshold)
    }
  })

  test("reads a role by its roster id and a member by the agent it runs", () => {
    expect(CompactionPolicy.roleThreshold({ id: "analyst" })).toEqual(CompactionPolicy.deepThreshold)
    expect(CompactionPolicy.roleThreshold({ agent: "team-tester" })).toEqual(CompactionPolicy.leanThreshold)
    expect(CompactionPolicy.roleThreshold({ agent: "team-developer" })).toEqual(CompactionPolicy.standardThreshold)
  })

  test("a planned member carries only its agent, which still names the role", () => {
    expect(CompactionPolicy.roleThreshold({ id: "ses_1", agent: "team-architect" })).toEqual(
      CompactionPolicy.deepThreshold,
    )
    expect(CompactionPolicy.roleThreshold({ id: "ses_2", agent: "team-debugger" })).toEqual(
      CompactionPolicy.leanThreshold,
    )
  })

  test("an unknown or missing role keeps the standard middle", () => {
    expect(CompactionPolicy.roleThreshold({ agent: "team-custom" })).toEqual(CompactionPolicy.standardThreshold)
    expect(CompactionPolicy.roleThreshold(undefined)).toEqual(CompactionPolicy.standardThreshold)
  })

  test("the main session gets the deepest threshold", () => {
    expect(CompactionPolicy.mainThreshold).toEqual(CompactionPolicy.deepThreshold)
    expect(CompactionPolicy.mainThreshold).toEqual({ type: "tokens", tokens: 900_000 })
    expect(CompactionPolicy.standardThreshold).toEqual({ type: "tokens", tokens: 500_000 })
    expect(CompactionPolicy.leanThreshold).toEqual({ type: "tokens", tokens: 300_000 })
  })
})

describe("SessionPlan capped thresholds", () => {
  test("parses the policy object into a tokens threshold", () => {
    expect(SessionPlan.parseThreshold(CompactionPolicy.deepThreshold)).toEqual({
      type: "tokens",
      tokens: 900_000,
    })
    expect(SessionPlan.parseThreshold(CompactionPolicy.standardThreshold)).toEqual({
      type: "tokens",
      tokens: 500_000,
    })
    expect(SessionPlan.parseThreshold(CompactionPolicy.leanThreshold)).toEqual({
      type: "tokens",
      tokens: 300_000,
    })
  })

  test("parses the policy object into a capped threshold", () => {
    expect(SessionPlan.parseThreshold({ percent: 80, tokens: 120_000 })).toEqual({
      type: "capped",
      percent: 80,
      tokens: 120_000,
    })
  })

  test("keeps the older forms working", () => {
    expect(SessionPlan.parseThreshold("60%")).toEqual({ type: "percent", percent: 60 })
    expect(SessionPlan.parseThreshold(60_000)).toEqual({ type: "tokens", tokens: 60_000 })
    expect(SessionPlan.parseThreshold("all")).toEqual({ type: "tokens", tokens: 0 })
  })

  test("refuses a capped threshold outside its range", () => {
    expect(SessionPlan.parseThreshold({ percent: 0, tokens: 1_000 })).toBeUndefined()
    expect(SessionPlan.parseThreshold({ percent: 101, tokens: 1_000 })).toBeUndefined()
    expect(SessionPlan.parseThreshold({ percent: 50, tokens: -1 })).toBeUndefined()
    expect(SessionPlan.parseThreshold({ percent: 50 })).toBeUndefined()
  })

  test("takes the smaller of the window share and the cap", () => {
    // 60% of a large window is still more than the cap, so the cap wins.
    expect(SessionPlan.thresholdTokens({ percent: 60, tokens: 60_000 }, 200_000)).toBe(60_000)
    // A small window keeps its share, which is below the cap.
    expect(SessionPlan.thresholdTokens({ percent: 60, tokens: 60_000 }, 50_000)).toBe(30_000)
    // A zero cap means the whole window, like a zero token count.
    expect(SessionPlan.thresholdTokens({ percent: 60, tokens: 0 }, 200_000)).toBe(0)
    // Without a window only the cap is known.
    expect(SessionPlan.thresholdTokens({ percent: 60, tokens: 60_000 }, undefined)).toBe(60_000)
  })

  test("old forms still resolve to the same numbers", () => {
    expect(SessionPlan.thresholdTokens("60%", 200_000)).toBe(120_000)
    expect(SessionPlan.thresholdTokens(60_000, 200_000)).toBe(60_000)
  })

  test("the compaction resolver applies a capped threshold too", () => {
    expect(resolveSessionThreshold({ percent: 60, tokens: 60_000 }, { context: 200_000, output: 32_000 })).toBe(60_000)
    expect(
      resolveSessionThreshold({ percent: 60, tokens: 60_000 }, { context: 50_000, input: 40_000, output: 8_000 }),
    ).toBe(24_000)
    // An unchanged share keeps its previous number.
    expect(resolveSessionThreshold("60%", { context: 200_000, output: 32_000 })).toBe(120_000)
  })
})
