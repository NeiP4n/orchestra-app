import { describe, expect, test } from "bun:test"
import { DesktopTool } from "@orchestra/core/tool/plugin/desktop"

// Step validation (block Б5, taxonomy G4): a missing argument fails as a
// typed ToolFailure before any step runs, not as a throw halfway through.
describe("DesktopTool.validateSteps", () => {
  test("accepts complete steps", () => {
    expect(
      DesktopTool.validateSteps([
        { action: "move", x: 10, y: 20 },
        { action: "type", text: "hi" },
        { action: "keys", keys: "ctrl+s" },
        { action: "screenshot" },
        { action: "click", x: 5, y: 5 },
      ]),
    ).toBeUndefined()
  })

  test("flags each missing argument with the step that needs it", () => {
    expect(DesktopTool.validateSteps([{ action: "move", x: 10 }])).toMatch(/pass x and y/)
    expect(DesktopTool.validateSteps([{ action: "type" }])).toMatch(/pass text/)
    expect(DesktopTool.validateSteps([{ action: "keys" }])).toMatch(/pass keys/)
    expect(DesktopTool.validateSteps([{ action: "focus" }])).toMatch(/window title/)
    expect(DesktopTool.validateSteps([{ action: "open" }])).toMatch(/pass the app/)
    expect(DesktopTool.validateSteps([{ action: "move", x: 1, y: 2 }, { action: "type" }])).toMatch(/step 2/)
  })
})
