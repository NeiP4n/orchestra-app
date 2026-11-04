import { describe, expect, test } from "bun:test"
import { OrchestraStage } from "@orchestra/core/stage"

// The acceptance gate that used to be dream_team_verify now lives in the
// stage engine as verifyAcceptance, scoring the CALLER's criteria (from a
// task or a stage plan) instead of a fixed five-item checklist. The retired
// dream-team tools are gone; these tests pin the gate's anti-gaming rules.

const criteria = [
  "The task's requirements are implemented, not partially or as a stub.",
  "The build passes.",
  "The tests pass (new or extended tests cover the change).",
  "The linter is clean for the changed files.",
  "Reviewer findings are resolved, not ignored.",
]

describe("stage acceptance verification", () => {
  test("reports 100% only when every criterion passes with evidence", () => {
    const report = OrchestraStage.verifyAcceptance(criteria, [
      { criterion: criteria[0]!, status: "pass", evidence: "diff reviewed" },
      { criterion: criteria[1]!, status: "pass", evidence: "bun run build ok" },
      { criterion: criteria[2]!, status: "pass", evidence: "12/12" },
      { criterion: criteria[3]!, status: "pass", evidence: "oxlint 0 errors" },
      { criterion: criteria[4]!, status: "pass", evidence: "no open findings" },
    ])
    expect(report.percent).toBe(100)
    expect(report.report).toContain("DONE (100%)")
  })

  test("a submitted subset of the criteria is not 100%", () => {
    const report = OrchestraStage.verifyAcceptance(criteria, [
      { criterion: criteria[1]!, status: "pass", evidence: "ok" },
      { criterion: criteria[2]!, status: "pass", evidence: "ok" },
    ])
    expect(report.percent).toBe(40)
    expect(report.gaps).toHaveLength(3)
    expect(report.report).toContain("NOT DONE (40%)")
  })

  test("a pass without evidence does not count, and duplicates do not inflate", () => {
    const report = OrchestraStage.verifyAcceptance(criteria, [
      { criterion: criteria[1]!, status: "pass", evidence: "   " },
      { criterion: criteria[2]!, status: "pass", evidence: "ok" },
      { criterion: criteria[2]!, status: "pass", evidence: "ok again" },
    ])
    expect(report.percent).toBe(20)
    expect(report.gaps.map((gap) => gap.criterion)).toContain(criteria[1])
  })

  test("items outside the given criteria are ignored, never scored", () => {
    const report = OrchestraStage.verifyAcceptance(criteria, [
      ...criteria.map((criterion) => ({ criterion, status: "pass" as const, evidence: "ok" })),
      { criterion: "Something nobody asked for", status: "pass" as const, evidence: "ok" },
    ])
    expect(report.total).toBe(5)
    expect(report.percent).toBe(100)
  })

  test("no criteria is not done — there is no universal checklist to fall back on", () => {
    const report = OrchestraStage.verifyAcceptance([], [])
    expect(report.percent).toBe(0)
    expect(report.report).toContain("no acceptance criteria were given")
  })

  test("the criteria are the caller's own: a two-criterion task scores out of two", () => {
    const report = OrchestraStage.verifyAcceptance(
      ["API returns 404 for a missing project", "Regression test added"],
      [
        { criterion: "API returns 404 for a missing project", status: "pass", evidence: "curl output in report" },
        { criterion: "Regression test added", status: "fail", evidence: "test not yet written" },
      ],
    )
    expect(report.percent).toBe(50)
    expect(report.gaps).toHaveLength(1)
  })
})
