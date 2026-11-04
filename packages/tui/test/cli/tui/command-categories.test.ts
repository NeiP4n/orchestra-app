import { describe, expect, test } from "bun:test"
import {
  COMMAND_CATEGORIES,
  commandCategory,
  commandCategoryRank,
  compareCommandCategories,
  isKnownCommandCategory,
} from "../../../src/component/command-categories"

describe("command categories", () => {
  test("maps legacy duplicate spellings onto the canonical category", () => {
    expect(commandCategory("Git")).toBe("VCS")
    expect(commandCategory("Dialogs")).toBe("Dialog")
    expect(commandCategory("Group")).toBe("Project")
    expect(commandCategory("Groups")).toBe("Project")
  })

  test("keeps canonical categories unchanged and trims whitespace", () => {
    for (const category of COMMAND_CATEGORIES) expect(commandCategory(category)).toBe(category)
    expect(commandCategory("  Session  ")).toBe("Session")
  })

  test("falls back to Other for a missing group and keeps unknown plugin groups visible", () => {
    expect(commandCategory(undefined)).toBe("Other")
    expect(commandCategory("")).toBe("Other")
    expect(commandCategory("My plugin")).toBe("My plugin")
  })

  test("ranks task categories before configuration and meta categories", () => {
    expect(commandCategoryRank("Session")).toBeLessThan(commandCategoryRank("Settings"))
    expect(commandCategoryRank("Settings")).toBeLessThan(commandCategoryRank("Debug"))
    expect(commandCategoryRank("Git")).toBe(commandCategoryRank("VCS"))
    expect(commandCategoryRank("My plugin")).toBeGreaterThan(commandCategoryRank("Other") - 1)
  })

  test("sorts entries by canonical category order, then by label", () => {
    const entries = [
      { group: "Settings", label: "Theme" },
      { group: "Git", label: "Status" },
      { group: "Session", label: "New session" },
      { group: "VCS", label: "Diff" },
      { group: "Session", label: "Archive session" },
    ]
    expect([...entries].sort(compareCommandCategories).map((entry) => entry.label)).toEqual([
      "Archive session",
      "New session",
      "Diff",
      "Status",
      "Theme",
    ])
  })

  test("recognizes known categories after normalization", () => {
    expect(isKnownCommandCategory("Git")).toBe(true)
    expect(isKnownCommandCategory("Session")).toBe(true)
    expect(isKnownCommandCategory("My plugin")).toBe(false)
    expect(isKnownCommandCategory(undefined)).toBe(false)
  })
})
