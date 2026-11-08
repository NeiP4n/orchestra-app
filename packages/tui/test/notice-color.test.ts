import { describe, expect, test } from "bun:test"
import { completionNoticeRole, toolRowRole } from "../src/routes/session/notice-color"

describe("completion notice colour", () => {
  const states = [undefined, "", "running", "completed", "finished", "cancelled", "error"] as const

  test.each(states)("state %p is red only when it is a real error", (state) => {
    for (const hovering of [false, true]) {
      const role = completionNoticeRole({ state, hovering })
      expect(role === "error").toBe(state === "error")
    }
  })

  test("a notice with no state (an instruction or system message) is never red", () => {
    expect(completionNoticeRole({ state: undefined, hovering: false })).toBe("info")
  })

  test("cancelled is a warning, a hovered link reads as plain text, and an error wins over hover", () => {
    expect(completionNoticeRole({ state: "cancelled", hovering: true })).toBe("warning")
    expect(completionNoticeRole({ state: "completed", hovering: true })).toBe("text")
    expect(completionNoticeRole({ state: "error", hovering: true })).toBe("error")
  })
})

describe("tool row colour", () => {
  test("only a failed call is red; a permission prompt is a warning even if it also failed", () => {
    expect(toolRowRole({ permission: false, failed: true, hovering: false })).toBe("error")
    expect(toolRowRole({ permission: true, failed: true, hovering: false })).toBe("warning")
    expect(toolRowRole({ permission: false, failed: false, hovering: false })).toBe("muted")
    expect(toolRowRole({ permission: false, failed: false, hovering: true })).toBe("text")
  })

  test("no combination without a failure is red", () => {
    for (const permission of [false, true])
      for (const hovering of [false, true])
        expect(toolRowRole({ permission, failed: false, hovering })).not.toBe("error")
  })
})
