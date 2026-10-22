import { expect, test } from "bun:test"
import { TuiKeybind } from "../src/config/keybind"

test("binds only the agent panel to shift+tab by default", () => {
  expect(TuiKeybind.Definitions["agent.panel"].default).toBe("shift+tab")
  expect(TuiKeybind.Definitions["agent.cycle"].default).toBe("none")
  expect(TuiKeybind.Definitions["agent.cycle.reverse"].default).toBe("none")
})
