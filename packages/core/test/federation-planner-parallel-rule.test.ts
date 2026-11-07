import { describe, expect, test } from "bun:test"
import { Federation } from "@orchestra/core/federation"

// A1 (octopus-camoc draft §2.4): the planner must parallelize only what is
// parallelizable. The rule lives in prompt text, so the test asserts the key
// phrases are present in the planner plan and in the planner/coder briefs.
describe("Planner parallelizability rule (A1)", () => {
  const plannerBrief = Federation.baseProjects.find((item) => item.key === "planner")!.brief
  const codersBrief = Federation.baseProjects.find((item) => item.key === "coders")!.brief

  test("plannerPlan asks the four parallelizability questions", () => {
    expect(Federation.plannerPlan).toContain("8. Parallelism: parallelize only what is parallelizable.")
    expect(Federation.plannerPlan).toContain("(1) Dependencies")
    expect(Federation.plannerPlan).toContain("(2) Shared state")
    expect(Federation.plannerPlan).toContain("(3) Tools")
    expect(Federation.plannerPlan).toContain("(4) Integration")
    expect(Federation.plannerPlan).toContain("16 or more tools")
  })

  test("plannerPlan defaults to one agent and records the reason for splitting", () => {
    expect(Federation.plannerPlan).toContain("Default: one agent.")
    expect(Federation.plannerPlan).toContain("Add agents only with a recorded reason for parallelizability")
    expect(Federation.plannerPlan).toContain("write the answers in the plan, next to the tasks on the DoD board")
  })

  test("plannerPlan softens the 30-agent target on sequential chains", () => {
    expect(Federation.plannerPlan).toContain("only where the work is parallelizable (see 8)")
    expect(Federation.plannerPlan).toContain("On a sequential chain, do not grow the team")
    expect(Federation.plannerPlan).toContain("until the Society counts 30 living agents (at least 21)")
  })

  test("planner brief carries the four questions and the one-agent default", () => {
    expect(plannerBrief).toContain("Parallelize only what is parallelizable")
    expect(plannerBrief).toContain("(1) Dependencies")
    expect(plannerBrief).toContain("(2) Shared state")
    expect(plannerBrief).toContain("(3) Tools")
    expect(plannerBrief).toContain("(4) Integration")
    expect(plannerBrief).toContain("Default: one agent")
    expect(plannerBrief).toContain("write the answers in the plan, next to the tasks on the DoD board")
  })

  test("coders brief no longer says 'when the work can be split' without a criterion", () => {
    expect(codersBrief).not.toContain("when the work can be split")
    expect(codersBrief).toContain("only when the work is truly parallelizable")
    expect(codersBrief).toContain("no shared file, zone or state")
    expect(codersBrief).toContain("16 or more tools, do not grow the team")
  })
})
