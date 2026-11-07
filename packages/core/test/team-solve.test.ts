import { describe, expect, test } from "bun:test"
import { Orchestra } from "@orchestra/schema/orchestra"
import { OrchestraStage } from "../src/stage"
import { TeamSolve } from "../src/team-solve"

const NOW = 1_700_000_000_000

const template = () => {
  const found = Orchestra.templates.find((item) => item.id === TeamSolve.TEAM_SOLVE_TEMPLATE_ID)
  if (!found) throw new Error("team-solve template is missing")
  return found
}

const schemaRoles = () =>
  Orchestra.roles.map((role) => ({ ...role, agent: Orchestra.role(role.id), origin: "builtin" as const }))

const stages = () => {
  const built = TeamSolve.buildStages(NOW)
  if (!built.ok) throw new Error(built.message)
  return built.value
}

describe("team-solve preset", () => {
  test("the preset is sound: six registered roles, template match, valid stage DAG", () => {
    expect(TeamSolve.validatePreset()).toBeUndefined()
  })

  test("staffs exactly the six roles, in pipeline order, one worker per role", () => {
    expect(TeamSolve.TEAM_SOLVE_ROLES).toEqual([
      "team-planner",
      "ideator-a",
      "ideator-b",
      "team-solver",
      "team-manager",
      "repairer",
    ])
    expect(new Set(TeamSolve.TEAM_SOLVE_ROLES).size).toBe(6)
    const staffed = Orchestra.rolesForTemplate({ ...template(), origin: "builtin" }, schemaRoles())
    expect(staffed.map((role) => role.id)).toEqual(TeamSolve.TEAM_SOLVE_ROLES)
  })

  test("the stage DAG: plan, two parallel ideators, solver after both, judge last", () => {
    const built = stages()
    expect(built.map((stage) => stage.id)).toEqual([
      "plan",
      "ideate-a",
      "ideate-b",
      "solve",
      "test",
      "review",
      "repair",
      "verify",
    ])
    expect(OrchestraStage.validate(built)).toBeUndefined()
    const byID = new Map(built.map((stage) => [stage.id, stage]))
    expect(byID.get("ideate-a")?.dependsOn).toEqual(["plan"])
    expect(byID.get("ideate-b")?.dependsOn).toEqual(["plan"])
    expect(byID.get("solve")?.dependsOn).toEqual(["ideate-a", "ideate-b"])
    expect(byID.get("verify")?.dependsOn).toEqual(["repair"])
    expect(byID.get("verify")?.roles).toEqual([])
    expect(byID.get("test")?.roles).toEqual([])
    expect(built.filter((stage) => stage.id === "repair")).toHaveLength(1)
    expect(TeamSolve.TEAM_SOLVE_MAX_REPAIR_ROUNDS).toBe(1)
  })

  test("every agent stage has exactly one role: its own fresh context, no shared session", () => {
    for (const stage of stages()) {
      if (stage.id === "test" || stage.id === "verify") continue
      expect(stage.roles).toHaveLength(1)
      expect(TeamSolve.TEAM_SOLVE_ROLES).toContain(stage.roles[0])
    }
    const agentStages = stages().filter((stage) => stage.roles.length > 0)
    expect(new Set(agentStages.map((stage) => stage.roles[0])).size).toBe(agentStages.length)
  })

  test("the ledger is files on disk: one file, five sections, two distinct markers", () => {
    expect(TeamSolve.TEAM_SOLVE_LEDGER).toBe(".orchestra/team-notes.md")
    expect(TeamSolve.TEAM_SOLVE_LEDGER_SECTIONS).toEqual([
      "Proposal A",
      "Proposal B",
      "Solver decision",
      "Review",
      "Repair",
    ])
    expect(TeamSolve.TEAM_SOLVE_MARKERS.proposalA).not.toBe(TeamSolve.TEAM_SOLVE_MARKERS.proposalB)
    expect(TeamSolve.TEAM_SOLVE_MARKERS.proposalA).toContain("team-solve:proposal-a")
    expect(TeamSolve.TEAM_SOLVE_MARKERS.proposalB).toContain("team-solve:proposal-b")
  })
})

describe("team-solve verdict: the test run decides, never a word or a vote", () => {
  test("a passing test run passes", () => {
    expect(TeamSolve.verdictFromTestRun({ exitCode: 0, failures: 0 }).passed).toBe(true)
  })

  test("a failing test run fails — even with a worker claiming it is done", () => {
    // The verdict takes only the test run: there is no parameter for a
    // worker's claim, a report, or a ballot, so no word can pass the task.
    // A "done" claim next to a failing run changes nothing.
    const verdict = TeamSolve.verdictFromTestRun({ exitCode: 1, failures: 2 })
    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toContain("exited 1")
  })

  test("exit 0 with failing checks is still a fail, and a missing run never passes", () => {
    expect(TeamSolve.verdictFromTestRun({ exitCode: 0, failures: 1 }).passed).toBe(false)
    expect(TeamSolve.verdictFromTestRun({ exitCode: -1, failures: 0 }).passed).toBe(false)
  })
})
