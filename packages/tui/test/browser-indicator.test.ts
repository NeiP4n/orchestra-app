import { expect, test } from "bun:test"
import { browserIndicator, browserRunningColor } from "../src/util/browser-indicator"

test("Chrome has explicit stopped, starting, running, stopping and error states independent of agent neurons", () => {
  expect(browserIndicator(undefined, false)).toMatchObject({ phase: "stopped", glyph: "○", label: "остановлен" })
  expect(browserIndicator(undefined, true)).toMatchObject({ phase: "running", glyph: "●", label: "работает" })
  expect(browserIndicator({ phase: "starting" }, false)).toMatchObject({ phase: "starting", glyph: "◐" })
  expect(browserIndicator({ phase: "stopping" }, true)).toMatchObject({ phase: "stopping", glyph: "◐" })
  expect(browserIndicator({ phase: "error", reason: "PID жив" }, true)).toMatchObject({ phase: "error", glyph: "✖", reason: "PID жив" })
  expect(browserIndicator({ phase: "stopped" }, true).phase).toBe("running")
  expect(browserIndicator(undefined, true, true).label).toBe("вкл")
})

import { RGBA } from "@opentui/core"
import { contrastRatio } from "../src/theme/system"
test("running Chrome stays green and readable across terminal backgrounds", () => {
  for (const hex of ["#000000", "#ffffff", "#191919", "#777777", "#a0a0a0", "#fff0dc", "#102030"]) {
    const background = RGBA.fromHex(hex)
    const foreground = browserRunningColor(background)
    expect(foreground.g).toBeGreaterThan(foreground.r)
    expect(foreground.g).toBeGreaterThan(foreground.b)
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5)
  }
})
