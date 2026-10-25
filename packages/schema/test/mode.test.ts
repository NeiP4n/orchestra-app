import { describe, expect, test } from "bun:test"
import { Mode } from "../src/mode.js"

const required = (id: string) => {
  const mode = Mode.of(id)
  if (!mode) throw new Error(`mode ${id} must exist`)
  return mode
}

describe("work modes", () => {
  test("ships a complete, unique set of presets", () => {
    expect(Mode.list()).toEqual([
      "auto",
      "fast",
      "coding",
      "research",
      "planning",
      "test",
      "architecture",
      "review",
      "debug",
      "design",
      "ops",
      "self-improvement",
    ])
    expect(new Set(Mode.list()).size).toBe(Mode.list().length)
    for (const mode of Mode.builtins) {
      expect(mode.name.trim().length).toBeGreaterThan(0)
      expect(mode.description.trim().length).toBeGreaterThan(10)
      if (mode.id !== "auto") {
        expect(mode.guidance.trim().length).toBeGreaterThan(80)
        expect(mode.steps).toBeGreaterThan(0)
      }
    }
  })

  test("separates read-only investigation from implementation", () => {
    for (const id of ["research", "planning", "review", "debug", "design"]) {
      expect(required(id).readOnly).toBe(true)
    }
    for (const id of ["auto", "fast", "coding", "ops", "self-improvement"]) {
      expect(required(id).readOnly).toBe(false)
    }
    expect(Mode.guidanceBlock(required("planning"))).toContain("read-only")
    expect(required("coding").readOnly).toBe(false)
    // A read-only planner can still receive coding mode to plan with code-level evidence.
    expect(Mode.guidanceBlock(required("coding"))).toContain("If your role is read-only, do not edit")
  })

  test("gives every kind of role a sensible default without changing its identity", () => {
    const role = (id: string, category: string, readOnly = false) =>
      Mode.defaultForRole({ id, category, readOnly })?.id

    expect(String(role("developer", "Build"))).toBe("coding")
    expect(String(role("architect", "Planning", true))).toBe("architecture")
    expect(String(role("researcher", "Planning", true))).toBe("research")
    expect(String(role("tester", "Quality", false))).toBe("test")
    expect(String(role("reviewer", "Quality", true))).toBe("review")
    expect(String(role("debugger", "Quality", true))).toBe("debug")
    expect(String(role("designer", "Build"))).toBe("design")
    expect(String(role("devops", "Build"))).toBe("ops")
    expect(String(role("reliability-engineer", "Build"))).toBe("ops")
    // A custom role may pin its own mode.
    expect(String(Mode.defaultForRole({ id: "translator", category: "Build", readOnly: true, mode: "fast" })?.id)).toBe(
      "fast",
    )
    // An unknown saved mode falls back to the category default instead of breaking the role.
    expect(String(Mode.defaultForRole({ id: "translator", category: "Build", readOnly: true, mode: "gone" })?.id)).toBe(
      "coding",
    )
    // A non-read-only quality role keeps its ability to edit tests.
    expect(Mode.defaultForRole({ id: "tester", category: "Quality", readOnly: false })?.readOnly).toBe(false)
    // Another planning role that may edit keeps coding; only the architect gets the architecture mode.
    expect(String(role("planner", "Planning", true))).toBe("planning")
  })

  test("only the test mode is silent, and unknown or missing modes are not", () => {
    expect(Mode.isQuiet({ [Mode.MetadataKey]: "test" })).toBe(true)
    expect(Mode.isQuiet({ [Mode.MetadataKey]: "coding" })).toBe(false)
    expect(Mode.isQuiet({ [Mode.MetadataKey]: "gone" })).toBe(false)
    expect(Mode.isQuiet(undefined)).toBe(false)
    // The tester is silent by default, with or without a stored mode; an explicit auto cancels it.
    expect(Mode.isQuiet({}, "team-tester")).toBe(true)
    expect(Mode.isQuiet(undefined, "team-tester")).toBe(true)
    expect(Mode.isQuiet({ [Mode.MetadataKey]: "auto" }, "team-tester")).toBe(false)
    expect(Mode.isQuiet({ [Mode.MetadataKey]: "coding" }, "team-tester")).toBe(false)
    expect(Mode.isQuiet({}, "team-developer")).toBe(false)
  })

  test("the architecture mode plans in parallel-safe tasks and cannot edit", () => {
    const mode = required("architecture")
    expect(mode.readOnly).toBe(true)
    expect(Mode.guidanceBlock(mode)).toContain("do not overlap")
    expect(required("test").readOnly).toBe(false)
  })

  test("self-improvement works from evidence and records what it proved", () => {
    const mode = required("self-improvement")
    expect(mode.readOnly).toBe(false)
    const text = Mode.guidanceBlock(mode)
    expect(text).toContain("baseline")
    expect(text).toContain("One change at a time")
    expect(text).toContain(".orchestra/self-improvement/")
    expect(text).toContain("NOT RUN")
    expect(text).not.toContain("todo")
  })

  test("reads and clears the stored override, including the explicit auto value", () => {
    expect(Mode.fromMetadata(undefined)).toBeUndefined()
    expect(Mode.fromMetadata({})).toBeUndefined()
    expect(String(Mode.fromMetadata({ [Mode.MetadataKey]: "planning" })?.id)).toBe("planning")
    expect(String(Mode.fromMetadata({ [Mode.MetadataKey]: "auto" })?.id)).toBe("auto")
    expect(Mode.fromMetadata({ [Mode.MetadataKey]: "gone" })).toBeUndefined()
    expect(Mode.fromMetadata({ [Mode.MetadataKey]: 3 })).toBeUndefined()
  })

  test("exposes the mode's step ceiling to the runner", () => {
    expect(Mode.stepsOf({ [Mode.MetadataKey]: "fast" })).toBe(20)
    expect(Mode.stepsOf({ [Mode.MetadataKey]: "auto" })).toBeUndefined()
    expect(Mode.stepsOf(undefined)).toBeUndefined()
  })

  test("renders the guidance the team session actually receives", () => {
    const text = Mode.guidanceBlock(required("fast"))
    expect(text).toContain("# Work mode: Fast (fast)")
    expect(text).toContain("one pass")
    // A step budget in the prompt made workers stop early; the guidance asks them to finish instead.
    expect(text).not.toContain("steps")
    expect(text).toContain("Carry the assigned scope through to the end")
    expect(Mode.guidanceBlock(required("auto"))).toBe("")
  })
})
