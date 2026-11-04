import { describe, expect, test } from "bun:test"
import { OrchestraStage } from "../src/stage"

const NOW = 1_700_000_000_000
let counter = 0
const makeID = () => `stage-${++counter}`

const plan = (inputs: OrchestraStage.StageInput[]) => {
  const result = OrchestraStage.mergePlan([], inputs, NOW, makeID)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

describe("stage validation", () => {
  test("rejects duplicate ids, unknown dependencies, self-dependency and cycles", () => {
    const base = plan([
      { id: "a", name: "A" },
      { id: "b", name: "B", dependsOn: ["a"] },
    ])
    expect(OrchestraStage.validate(base)).toBeUndefined()
    expect(OrchestraStage.validate([...base, base[0]!])).toContain("Duplicate")
    expect(
      OrchestraStage.validate([{ ...base[0]!, dependsOn: ["nope"] }]),
    ).toContain("unknown stage")
    expect(OrchestraStage.validate([{ ...base[0]!, dependsOn: ["a"] }])).toContain("itself")
    const cyclic = plan([
      { id: "x", name: "X" },
      { id: "y", name: "Y", dependsOn: ["x"] },
    ])
    expect(OrchestraStage.validate([{ ...cyclic[0]!, dependsOn: ["y"] }, cyclic[1]!])).toContain("cycle")
  })

  test("mergePlan refuses duplicate ids inside one plan and stages without a name", () => {
    expect(OrchestraStage.mergePlan([], [{ id: "a", name: "A" }, { id: "a", name: "Again" }], NOW, makeID).ok).toBe(false)
    expect(OrchestraStage.mergePlan([], [{ name: "  " }], NOW, makeID).ok).toBe(false)
  })
})

describe("stage transitions", () => {
  const start = plan([
    { id: "research", name: "Research", acceptance: "sources cited" },
    { id: "build", name: "Build", dependsOn: ["research"] },
  ])

  test("a stage may start only when its dependencies are completed", () => {
    const blocked = OrchestraStage.applyPatch(start, "build", { status: "running" }, NOW)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.message).toContain("dependencies not completed")

    const running = OrchestraStage.applyPatch(start, "research", { status: "running" }, NOW)
    expect(running.ok).toBe(true)
  })

  test("completion requires running status and a result as evidence", () => {
    const fromPlanned = OrchestraStage.applyPatch(start, "research", { status: "completed", result: "done" }, NOW)
    expect(fromPlanned.ok).toBe(false)

    const running = OrchestraStage.applyPatch(start, "research", { status: "running" }, NOW)
    if (!running.ok) throw new Error(running.message)
    const bare = OrchestraStage.applyPatch(running.value, "research", { status: "completed" }, NOW)
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.message).toContain("result")

    const done = OrchestraStage.applyPatch(running.value, "research", { status: "completed", result: "report: 12 sources" }, NOW)
    expect(done.ok).toBe(true)
    if (!done.ok) throw new Error(done.message)
    const stage = done.value.find((item) => item.id === "research")!
    expect(stage.status).toBe("completed")
    expect(stage.completed).toBe(NOW)
    expect(stage.result).toBe("report: 12 sources")
    // Its dependent is now actionable.
    expect(OrchestraStage.actionable(done.value).map((item) => item.id)).toEqual(["build"])
  })

  test("completed stages are immutable", () => {
    const running = OrchestraStage.applyPatch(start, "research", { status: "running" }, NOW)
    if (!running.ok) throw new Error(running.message)
    const done = OrchestraStage.applyPatch(running.value, "research", { status: "completed", result: "evidence" }, NOW)
    if (!done.ok) throw new Error(done.message)
    expect(OrchestraStage.applyPatch(done.value, "research", { status: "planned" }, NOW).ok).toBe(false)
    expect(OrchestraStage.applyPatch(done.value, "research", { result: "rewritten" }, NOW).ok).toBe(false)
    expect(OrchestraStage.applyPatch(done.value, "research", { name: "Renamed" }, NOW).ok).toBe(false)
  })

  test("blocked and failed stages can be replanned back to planned", () => {
    const running = OrchestraStage.applyPatch(start, "research", { status: "running" }, NOW)
    if (!running.ok) throw new Error(running.message)
    const blocked = OrchestraStage.applyPatch(running.value, "research", { status: "blocked", result: "waiting on API key" }, NOW)
    if (!blocked.ok) throw new Error(blocked.message)
    const back = OrchestraStage.applyPatch(blocked.value, "research", { status: "planned" }, NOW)
    expect(back.ok).toBe(true)
  })

  test("unknown stage ids are refused with the known ids listed", () => {
    const result = OrchestraStage.applyPatch(start, "nope", { status: "running" }, NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("research")
  })
})

describe("replanning", () => {
  test("preserves completed stages exactly, keeps live status of running ones, drops omitted open stages", () => {
    const initial = plan([
      { id: "research", name: "Research" },
      { id: "build", name: "Build", dependsOn: ["research"] },
      { id: "extra", name: "Extra" },
    ])
    const running = OrchestraStage.applyPatch(initial, "research", { status: "running" }, NOW)
    if (!running.ok) throw new Error(running.message)
    const done = OrchestraStage.applyPatch(running.value, "research", { status: "completed", result: "evidence" }, NOW)
    if (!done.ok) throw new Error(done.message)
    const buildRunning = OrchestraStage.applyPatch(done.value, "build", { status: "running" }, NOW)
    if (!buildRunning.ok) throw new Error(buildRunning.message)

    const replanned = OrchestraStage.mergePlan(
      buildRunning.value,
      [
        { id: "research", name: "Research REDEFINED", acceptance: "changed" },
        { id: "build", name: "Build v2" },
        { id: "verify", name: "Verify", dependsOn: ["build"] },
      ],
      NOW + 1,
      makeID,
    )
    expect(replanned.ok).toBe(true)
    if (!replanned.ok) throw new Error(replanned.message)
    const byID = new Map(replanned.value.map((stage) => [stage.id, stage]))
    // The completed stage kept its recorded name, acceptance and evidence.
    expect(byID.get("research")?.name).toBe("Research")
    expect(byID.get("research")?.result).toBe("evidence")
    // The running stage kept its status under its new definition.
    expect(byID.get("build")?.status).toBe("running")
    expect(byID.get("build")?.name).toBe("Build v2")
    // The omitted open stage is gone; the new one is planned.
    expect(byID.has("extra")).toBe(false)
    expect(byID.get("verify")?.status).toBe("planned")
  })

  test("a completed stage the new plan omits stays on the record", () => {
    const initial = plan([{ id: "research", name: "Research" }])
    const running = OrchestraStage.applyPatch(initial, "research", { status: "running" }, NOW)
    if (!running.ok) throw new Error(running.message)
    const done = OrchestraStage.applyPatch(running.value, "research", { status: "completed", result: "evidence" }, NOW)
    if (!done.ok) throw new Error(done.message)
    const replanned = OrchestraStage.mergePlan(done.value, [{ id: "next", name: "Next" }], NOW + 1, makeID)
    expect(replanned.ok).toBe(true)
    if (!replanned.ok) throw new Error(replanned.message)
    expect(replanned.value.map((stage) => stage.id)).toEqual(["next", "research"])
  })
})

describe("progress and rendering", () => {
  test("done requires every stage settled and at least one completed", () => {
    const stages = plan([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ])
    expect(OrchestraStage.progress(stages).done).toBe(false)
    const cancelled = stages.map((stage) => ({ ...stage, status: "cancelled" as const }))
    expect(OrchestraStage.progress(cancelled).done).toBe(false)
    const mixed = [
      { ...stages[0]!, status: "completed" as const },
      { ...stages[1]!, status: "cancelled" as const },
    ]
    expect(OrchestraStage.progress(mixed).done).toBe(true)
    expect(OrchestraStage.render(mixed)).toContain("1/2 completed")
    expect(OrchestraStage.render([])).toContain("No workflow stages")
  })
})
