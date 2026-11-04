import { describe, expect, test } from "bun:test"
import { barFill, interactiveBlockOf, interactiveResponseOf, planProgress, statusGlyph } from "../src/util/interactive"

describe("interactiveBlockOf", () => {
  test("narrows a decision block and drops malformed options", () => {
    const block = interactiveBlockOf({
      type: "decision",
      title: "Choose",
      options: [
        { id: "a", label: "A", pros: ["fast", 42], recommended: true },
        { label: "missing id" },
        "garbage",
      ],
    })
    expect(block?.type).toBe("decision")
    if (block?.type === "decision") {
      expect(block.options).toHaveLength(1)
      expect(block.options[0].pros).toEqual(["fast"])
      expect(block.options[0].recommended).toBe(true)
    }
  })

  test("rejects unknown types, missing titles and executable extras ride along harmlessly", () => {
    expect(interactiveBlockOf({ type: "html", title: "x" })).toBeUndefined()
    expect(interactiveBlockOf({ type: "decision", options: [] })).toBeUndefined()
    expect(interactiveBlockOf(undefined)).toBeUndefined()
    expect(interactiveBlockOf("decision")).toBeUndefined()
    const block = interactiveBlockOf({
      type: "approval",
      title: "Deploy",
      action: "Ship it",
      script: "rm -rf /",
    })
    expect(block?.type).toBe("approval")
    // the view carries only declared fields; the smuggled key never reaches a renderer
    expect(block && "script" in block).toBe(false)
  })

  test("comparison attributes keep only string values", () => {
    const block = interactiveBlockOf({
      type: "comparison",
      title: "DB",
      items: [
        { id: "pg", name: "Postgres", attributes: { license: "PostgreSQL", price: 12 } },
        { id: "my", name: "MySQL" },
      ],
    })
    expect(block?.type).toBe("comparison")
    if (block?.type === "comparison") expect(block.items[0].attributes).toEqual({ license: "PostgreSQL" })
  })
})

describe("interactiveResponseOf", () => {
  test("keeps only the declared response fields", () => {
    expect(interactiveResponseOf({ selected: ["a"], decision: "approved", comment: "go", evil: 1 })).toEqual({
      selected: ["a"],
      decision: "approved",
      comment: "go",
    })
    expect(interactiveResponseOf({ decision: "maybe" })?.decision).toBeUndefined()
    expect(interactiveResponseOf(undefined)).toBeUndefined()
  })
})

describe("rendering helpers", () => {
  test("status glyphs cover every stage status", () => {
    expect(statusGlyph("completed")).toBe("✓")
    expect(statusGlyph("running")).toBe("▸")
    expect(statusGlyph("failed")).toBe("✗")
    expect(statusGlyph("planned")).toBe("○")
  })

  test("plan progress counts completed tasks only", () => {
    const block = interactiveBlockOf({
      type: "plan",
      title: "P",
      phases: [
        {
          title: "One",
          tasks: [
            { title: "a", status: "completed" },
            { title: "b", status: "running" },
            { title: "c", status: "completed" },
          ],
        },
      ],
    })
    expect(block?.type).toBe("plan")
    if (block?.type === "plan") expect(planProgress(block)).toEqual({ done: 2, total: 3 })
  })

  test("bars are fixed width and clamp out-of-range values", () => {
    expect(barFill(50, 100, 10)).toBe("█████░░░░░")
    expect(barFill(150, 100, 10)).toBe("██████████")
    expect(barFill(-5, 100, 10)).toBe("░░░░░░░░░░")
    expect(barFill(1, 0, 10)).toBe("░░░░░░░░░░")
  })
})
