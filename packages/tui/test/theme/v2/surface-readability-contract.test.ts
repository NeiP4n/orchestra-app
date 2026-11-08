import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { expandTheme, resolveTheme, selectTheme, type ThemeDefinition } from "@orchestra/theme/tui"
import { getOrchestraTheme } from "../../../src/theme"

// Independent numeric oracle. Do not import the resolver's private repair helpers.
function luminance(color: RGBA) {
  const channel = (value: number) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function over(top: RGBA, under: RGBA) {
  return RGBA.fromValues(
    top.r * top.a + under.r * (1 - top.a),
    top.g * top.a + under.g * (1 - top.a),
    top.b * top.a + under.b * (1 - top.a),
    1,
  )
}

function ratio(foreground: RGBA, background: RGBA) {
  const fg = luminance(foreground.a < 1 ? over(foreground, background) : foreground)
  const bg = luminance(background)
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
}

function merge(...values: unknown[]): Record<string, unknown> {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
  return values.reduce<Record<string, unknown>>((result, value) => {
    if (!record(value)) return result
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      result[key] = record(item) ? merge(result[key], item) : item
    }
    return result
  }, {})
}

function fixture(mode: "light" | "dark", readable: boolean) {
  const background = {
    base: "#ffffff",
    raised: { base: "#ffffff", high: "#ffffff", max: "#ffffff" },
    action: {
      primary: {
        base: "#ffffff",
        $hovered: "transparent",
        $pressed: "transparent",
        $focused: "#ffffff",
        $selected: "transparent",
        $disabled: "transparent",
      },
    },
  }
  return merge(selectTheme(getOrchestraTheme(), mode), {
    text: { base: "#111111", action: { primary: { base: "$text.base", $pressed: "#222222" } } },
    "@dialog": {
      ...(readable ? { background } : {}),
      text: { base: "#333333", action: { primary: { base: "#444444", $focused: "#555555" } } },
    },
  }) as ThemeDefinition
}

for (const mode of ["light", "dark"] as const) {
  test(`surface fixture preserves authored colors above the floor in every state ${mode}`, () => {
    const view = resolveTheme(fixture(mode, true)).surface("dialog")
    expect(view.text.base.toInts()).toEqual([51, 51, 51, 255])
    expect(view.text.action.primary.pressed.toInts()).toEqual([68, 68, 68, 255])
    expect(view.text.action.primary.focused.toInts()).toEqual([85, 85, 85, 255])
    const numbers = []
    for (const state of ["base", "hovered", "pressed", "focused", "selected", "disabled"] as const) {
      const foreground = view.text.action.primary[state]
      const own = view.background.action.primary[state]
      expect(foreground.toInts()).toEqual(state === "focused" ? [85, 85, 85, 255] : [68, 68, 68, 255])
      expect(own.a).toBe(state === "base" || state === "focused" ? 1 : 0)
      for (const under of [view.background.base, view.background.raised.base]) {
        const background = own.a < 1 ? over(own, under) : own
        const contrast = ratio(foreground, background)
        numbers.push({ state, foreground: foreground.toInts(), background: background.toInts(), contrast })
        expect(contrast).toBeGreaterThanOrEqual(state === "disabled" ? 3 : 4.5)
      }
    }
    for (const background of [view.background.base, view.background.raised.base, view.background.raised.high]) {
      expect(ratio(view.text.base, background)).toBeGreaterThanOrEqual(4.5)
    }
    console.log(JSON.stringify({ mode, kind: "readable fixture all states", numbers }))
  })

  test(`low contrast focused override is repaired through the public surface API ${mode}`, () => {
    const input = fixture(mode, false)
    const expanded = expandTheme(input)
    expect(expanded["@dialog"]?.text?.action?.primary?.$focused).toBe("#555555")
    // resolveTheme performs the contextualization internally; no private helper is exported.
    const view = resolveTheme(expanded).surface("dialog")
    const background = view.background.action.primary.focused
    const authored = RGBA.fromHex("#555555")
    expect(background.toInts()).toEqual(mode === "light" ? [49, 135, 149, 255] : [86, 182, 194, 255])
    expect(ratio(authored, background)).toBeLessThan(4.5)
    expect(ratio(view.text.action.primary.focused, background)).toBeGreaterThanOrEqual(4.5)
    expect(view.text.action.primary.focused.equals(authored)).toBeFalse()
    console.log(JSON.stringify({
      mode,
      kind: "low contrast public resolveTheme",
      background: background.toInts(),
      authoredContrast: ratio(authored, background),
      repaired: view.text.action.primary.focused.toInts(),
      repairedContrast: ratio(view.text.action.primary.focused, background),
    }))
  })
}
