import { describe, expect, test } from "bun:test"
import { assembleTeam, formatPlan, verifyChecklist, type DreamAgent } from "@orchestra/core/tool/plugin/dream-team"

const agents: DreamAgent[] = [
  { id: "build", name: "Build", mode: "all", hidden: false },
  { id: "explore", name: "Explore", mode: "subagent", hidden: false },
  { id: "plan", name: "Plan", mode: "primary", hidden: false },
  { id: "secret", name: "Secret", mode: "subagent", hidden: true },
]

describe("dream team assemble", () => {
  test("assigns roles only to real, non-primary, visible agents", () => {
    const plan = assembleTeam("Add search", agents)
    expect(plan.roles.length).toBe(5)
    for (const role of plan.roles) {
      expect(role.agent).toMatch(/^(build|explore) \(/)
    }
    expect(formatPlan(plan)).toContain("Dream team for: Add search")
    expect(plan.criteria.length).toBeGreaterThan(0)
  })

  test("falls back to the orchestrator itself when no subagent exists", () => {
    const plan = assembleTeam("Add search", [])
    expect(plan.roles[0]?.agent).toContain("orchestrator itself")
  })
})

describe("dream team verify gate", () => {
  test("reports 100% only when every plan criterion passes with evidence", () => {
    const report = verifyChecklist([
      { criterion: "The task's requirements are implemented, not partially or as a stub.", status: "pass", evidence: "diff reviewed" },
      { criterion: "The build passes.", status: "pass", evidence: "bun run build ok" },
      { criterion: "The tests pass (new or extended tests cover the change).", status: "pass", evidence: "12/12" },
      { criterion: "The linter is clean for the changed files.", status: "pass", evidence: "oxlint 0 errors" },
      { criterion: "Reviewer findings are resolved, not ignored.", status: "pass", evidence: "no open findings" },
    ])
    expect(report.percent).toBe(100)
    expect(report.report).toContain("DONE (100%)")
  })

  test("a submitted subset of the plan criteria is not 100%", () => {
    const report = verifyChecklist([
      { criterion: "The build passes.", status: "pass", evidence: "ok" },
      { criterion: "The tests pass (new or extended tests cover the change).", status: "pass", evidence: "ok" },
    ])
    expect(report.percent).toBe(40)
    expect(report.gaps).toHaveLength(3)
    expect(report.report).toContain("NOT DONE (40%)")
  })

  test("a pass without evidence does not count, and duplicates do not inflate", () => {
    const report = verifyChecklist([
      { criterion: "The build passes.", status: "pass", evidence: "   " },
      { criterion: "The tests pass (new or extended tests cover the change).", status: "pass", evidence: "ok" },
      { criterion: "The tests pass (new or extended tests cover the change).", status: "pass", evidence: "ok again" },
    ])
    expect(report.percent).toBe(20)
    expect(report.gaps.map((gap) => gap.criterion)).toContain("The build passes.")
  })

  test("empty checklist is not done", () => {
    expect(verifyChecklist([]).percent).toBe(0)
  })
})
