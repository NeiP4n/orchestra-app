import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { hoverBackground } from "../src/ui/hover"

test("uses the shared raised-high surface for hover", () => {
  const raisedHigh = "#262626"
  let increaseCalls = 0
  const value = hoverBackground({
    background: { base: "#101010", raised: { base: "#181818", high: raisedHigh } },
    increase: () => {
      increaseCalls++
      return "#222222"
    },
  })
  expect(value).toBe(raisedHigh)
  expect(increaseCalls).toBe(0)
})

test("falls back for a minimal theme without a raised-high surface", () => {
  const raisedBase = "#181818"
  const fallback = "#202020"
  const value = hoverBackground({
    background: { base: "#101010", raised: { base: raisedBase } },
    increase: (color, amount) => {
      expect(color).toBe(raisedBase)
      expect(amount).toBe(4)
      return fallback
    },
  })
  expect(value).toBe(fallback)
})

test("creates a visible neutral hover surface when raised-high equals the panel background", () => {
  const base = RGBA.fromHex("#101820")
  const value = hoverBackground({
    background: { base, raised: { base, high: RGBA.clone(base) } },
  })
  expect(value).toBeInstanceOf(RGBA)
  expect(value.equals(base)).toBe(false)
})

test("prefers the semantic action hover token when the theme provides one", () => {
  const actionHover = "#27465a"
  const value = hoverBackground({
    background: {
      base: "#101010",
      raised: { base: "#181818", high: "#262626" },
      action: { primary: { hovered: actionHover } },
    },
  })
  expect(value).toBe(actionHover)
})

test("ignores a transparent action hover token and falls back to the raised surface", () => {
  const base = RGBA.fromHex("#101010")
  const raisedHigh = RGBA.fromHex("#262626")
  const value = hoverBackground({
    background: {
      base,
      raised: { base, high: raisedHigh },
      action: { primary: { hovered: RGBA.fromInts(0, 0, 0, 0) } },
    },
  })
  expect(value.equals(raisedHigh)).toBe(true)
})
