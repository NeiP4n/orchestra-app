import { test, expect } from "bun:test"
import { createTerminalCapabilities } from "@opentui/core/testing"
import {
  browserGraphicsPreference as preference,
  browserGraphicsProtocol as protocol,
  browserFrameGap,
} from "../src/util/browser-graphics"
import { readFileSync } from "node:fs"
const pixels = { width: 1200, height: 800 }
test("auto uses negotiated native graphics instead of blanket Windows blocks; unknown/unsupported/tmux remain blocks", () => {
  const requested = preference({})
  expect(requested).toBe("auto")
  expect(protocol(requested, null, pixels)).toBe("blocks")
  expect(protocol(requested, createTerminalCapabilities({ kitty_graphics: false, sixel: false }), pixels)).toBe(
    "blocks",
  )
  expect(protocol(requested, createTerminalCapabilities({ kitty_graphics: true, sixel: false }), pixels)).toBe("kitty")
  expect(protocol(requested, createTerminalCapabilities({ kitty_graphics: false, sixel: true }), pixels)).toBe("sixel")
  expect(protocol(requested, createTerminalCapabilities({ kitty_graphics: false, sixel: true }), null)).toBe("blocks")
  expect(
    protocol(requested, createTerminalCapabilities({ kitty_graphics: true, sixel: true, multiplexer: "tmux" }), pixels),
  ).toBe("blocks")
  expect(
    protocol(requested, createTerminalCapabilities({ kitty_graphics: true, image_protocol: "blocks" }), pixels),
  ).toBe("blocks")
})
test("explicit protocol and legacy blocks preference survive; native graphics do not increase frame decode rate", () => {
  expect(preference({ ORCHESTRA_BROWSER_HALFBLOCKS: "1" })).toBe("blocks")
  expect(preference({ ORCHESTRA_BROWSER_HALFBLOCKS: "0" })).toBe("auto")
  expect(preference({ ORCHESTRA_BROWSER_GFX: "blocks", ORCHESTRA_BROWSER_HALFBLOCKS: "0" })).toBe("blocks")
  expect(preference({ ORCHESTRA_BROWSER_GFX: "kitty", ORCHESTRA_BROWSER_HALFBLOCKS: "1" })).toBe("kitty")
  expect(browserFrameGap("sixel")).toBeGreaterThanOrEqual(browserFrameGap("blocks"))
  expect(browserFrameGap("kitty")).toBe(300)
  const source = readFileSync(new URL("../src/component/browser-pane.tsx", import.meta.url), "utf8")
  expect(source).toContain("protocol={imageProtocol()}")
  expect(source).toContain("const MAX_WIDTH = 1600")
  expect(source).toContain("const MAX_HEIGHT = 1000")
  expect(source).toContain("Чётко в окне")
  expect(source).toContain('switchMode("window")')
  expect(source).toContain("CliRenderEvents.CAPABILITIES")
})
