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
  test("reports 100% only when every criterion passes", () => {
    const report = verifyChecklist([
      { criterion: "Build passes", status: "pass", evidence: "bun run build ok" },
      { criterion: "Tests pass", status: "pass", evidence: "12/12" },
    ])
    expect(report.percent).toBe(100)
    expect(report.report).toContain("DONE (100%)")
  })

  test("reports the exact gaps otherwise", () => {
    const report = verifyChecklist([
      { criterion: "Build passes", status: "pass", evidence: "ok" },
      { criterion: "Tests pass", status: "fail", evidence: "2 failing" },
    ])
    expect(report.percent).toBe(50)
    expect(report.gaps.map((gap) => gap.criterion)).toEqual(["Tests pass"])
    expect(report.report).toContain("NOT DONE (50%)")
  })

  test("empty checklist is not done", () => {
    expect(verifyChecklist([]).percent).toBe(0)
  })
})
