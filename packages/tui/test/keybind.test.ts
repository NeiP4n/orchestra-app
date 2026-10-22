import { expect, test } from "bun:test"
import { TuiKeybind } from "../src/config/keybind"

test("binds the agent panel to shift+tab and the leader shortcut by default", () => {
  expect(TuiKeybind.Definitions["agent.panel"].default).toBe("shift+tab,<leader>a")
  expect(TuiKeybind.Definitions["agent.cycle"].default).toBe("none")
  expect(TuiKeybind.Definitions["agent.cycle.reverse"].default).toBe("none")
})
