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

test("synthesized hover surfaces retain readable primary and muted text", () => {
  const background = RGBA.fromHex("#101820")
  const primary = RGBA.fromHex("#e8edf2")
  const muted = RGBA.fromHex("#9caab4")
  const value = hoverBackground({
    background: { base: background, raised: { base: background, high: RGBA.clone(background) } },
    text: { base: primary, muted },
    increase: () => RGBA.clone(background),
  })
  const luminance = (color: RGBA) => {
    const channel = (value: number) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }
  const ratio = (foreground: RGBA, surface: RGBA) => {
    const fg = luminance(foreground)
    const bg = luminance(surface)
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
  }
  expect(ratio(primary, value)).toBeGreaterThanOrEqual(3)
  expect(ratio(muted, value)).toBeGreaterThanOrEqual(3)
})

test("selects the requested secondary or destructive hover surface", () => {
  const secondary = "#304050"
  const destructive = "#6b2630"
  const theme = {
    background: {
      base: "#101010",
      raised: { base: "#181818", high: "#242424" },
      action: {
        primary: { hovered: "#303030" },
        secondary: { hovered: secondary },
        destructive: { hovered: destructive },
      },
    },
  }
  expect(hoverBackground(theme, "secondary")).toBe(secondary)
  expect(hoverBackground(theme, "destructive")).toBe(destructive)
})

function luminance(color: RGBA) {
  const channel = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function contrast(foreground: RGBA, background: RGBA) {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test("neutral fallback preserves readable primary and muted text", () => {
  const background = RGBA.fromHex("#101820")
  const primary = RGBA.fromHex("#ffffff")
  const muted = RGBA.fromHex("#808080")
  const hover = hoverBackground({
    background: { base: background, raised: { base: RGBA.clone(background), high: RGBA.clone(background) } },
    text: { base: primary, muted },
  })
  expect(hover).toBeInstanceOf(RGBA)
  expect(contrast(primary, hover as RGBA)).toBeGreaterThanOrEqual(3)
  expect(contrast(muted, hover as RGBA)).toBeGreaterThanOrEqual(3)
})

test("dark surfaces reject a white semantic hover fill and keep both text colors readable", () => {
  const base = RGBA.fromHex("#101820"), text = RGBA.fromHex("#f4f4f4"), muted = RGBA.fromHex("#9cabb8")
  const value = hoverBackground({ background: { base, raised: { base, high: RGBA.fromHex("#ffffff") }, action: { primary: { hovered: RGBA.fromHex("#ffffff") } } }, text: { base: text, muted } })
  expect(luminance(value)).toBeLessThan(0.35)
  expect(contrast(text, value)).toBeGreaterThanOrEqual(3)
  expect(contrast(muted, value)).toBeGreaterThanOrEqual(3)
})
