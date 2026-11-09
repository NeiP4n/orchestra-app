import { expect, test } from "bun:test"
import { browserIndicator } from "../src/util/browser-indicator"

test("Chrome has explicit stopped, starting, running, stopping and error states independent of agent neurons", () => {
  expect(browserIndicator(undefined, false)).toMatchObject({ phase: "stopped", glyph: "○", label: "остановлен" })
  expect(browserIndicator(undefined, true)).toMatchObject({ phase: "running", glyph: "●", label: "работает" })
  expect(browserIndicator({ phase: "starting" }, false)).toMatchObject({ phase: "starting", glyph: "◐" })
  expect(browserIndicator({ phase: "stopping" }, true)).toMatchObject({ phase: "stopping", glyph: "◐" })
  expect(browserIndicator({ phase: "error", reason: "PID жив" }, true)).toMatchObject({ phase: "error", glyph: "✖", reason: "PID жив" })
  expect(browserIndicator({ phase: "stopped" }, true).phase).toBe("running")
  expect(browserIndicator(undefined, true, true).label).toBe("вкл")
})
