import { expect, test } from "bun:test"
import { resolveTheme, selectTheme, type ThemeDefinition } from "@orchestra/theme/tui"
import { getOrchestraTheme } from "../../../src/theme"

function definition(mode: "light" | "dark") {
  const base = structuredClone(selectTheme(getOrchestraTheme(), mode))
  return {
    ...base,
    background: {
      ...base.background,
      base: "#123456",
      raised: { ...base.background.raised, base: "$background.base", high: "#123456" },
      formfield: { ...base.background.formfield, base: "$background.raised.base" },
    },
  } satisfies ThemeDefinition
}

for (const mode of ["light", "dark"] as const) {
  test(`reference mutation ownership is shared within view, isolated across views and calls ${mode}`, () => {
    const input = definition(mode)
    const before = structuredClone(input)
    const old = resolveTheme(input)
    const independent = resolveTheme(input)
    const dialog = old.surface("dialog")
    const dialogBefore = dialog.background.base.toInts()
    expect(old.background.raised.base).toBe(old.background.base)
    expect(independent.background.base).not.toBe(old.background.base)
    expect(dialog.background.base).not.toBe(old.background.base)
    old.background.base.r = 0.9
    const quantized = old.background.base.r
    expect(old.background.raised.base.r).toBe(old.background.base.r)
    expect(independent.background.base.toInts()).toEqual([18, 52, 86, 255])
    expect(dialog.background.base.toInts()).toEqual(dialogBefore)
    expect(input).toEqual(before)
    input.background.base = "#345678"
    const fresh = resolveTheme(input)
    expect(fresh.background.base.toInts()).toEqual([52, 86, 120, 255])
    expect(fresh.background.raised.base).toBe(fresh.background.base)
    expect(old.background.base.r).toBe(quantized)
    expect(independent.background.base.toInts()).toEqual([18, 52, 86, 255])
  })

  test(`readability repairs never mutate hue scales or input ${mode}`, () => {
    const input = definition(mode)
    const before = structuredClone(input)
    const clean = resolveTheme(input)
    const lowContrast = structuredClone(input)
    lowContrast.text = { ...lowContrast.text, base: "$hue.neutral.800", muted: "$hue.neutral.800" }
    const lowBefore = structuredClone(lowContrast)
    const repaired = resolveTheme(lowContrast)
    const bytes = (theme: ReturnType<typeof resolveTheme>) =>
      Object.fromEntries(
        Object.entries(theme.hue).map(([name, scale]) => [
          name,
          Object.fromEntries(Object.entries(scale).map(([step, color]) => [step, color.toInts()])),
        ]),
      )
    expect(bytes(repaired)).toEqual(bytes(clean))
    expect(input).toEqual(before)
    expect(lowContrast).toEqual(lowBefore)
  })

  test(`transparent and raw state-path references retain target identity ${mode}`, () => {
    const input = definition(mode)
    input.background.base = "transparent"
    input.background.action = {
      ...input.background.action,
      primary: { base: "#123456", $hovered: "#234567", $pressed: "$background.action.primary.$hovered" },
    }
    const theme = resolveTheme(input)
    expect(theme.background.base.a).toBe(0)
    expect(theme.background.raised.base).toBe(theme.background.base)
    expect(theme.background.action.primary.pressed).toBe(theme.background.action.primary.hovered)
    expect(theme.background.action.primary.hovered.toInts()).toEqual([35, 69, 103, 255])
    // Reference grammar is the raw source key; normalized output key is not silently accepted.
    input.background.action = {
      ...input.background.action,
      primary: { ...input.background.action.primary, $pressed: "$background.action.primary.hovered" },
    }
    expect(() => resolveTheme(input)).toThrow('Theme reference "$background.action.primary.hovered" was not found')
  })
}

for (const reverse of [false, true])
  test(`self-cycle and mutual cycle reject in traversal order ${reverse}`, () => {
    const input = definition("dark")
    input.background = { ...input.background, base: "$background.base" }
    expect(() => resolveTheme(input)).toThrow("Circular theme reference")
    const pair = reverse
      ? { high: "$background.raised.base", base: "$background.raised.high" }
      : { base: "$background.raised.high", high: "$background.raised.base" }
    input.background = { ...input.background, base: "#123456", raised: { ...input.background.raised, ...pair } }
    expect(() => resolveTheme(input)).toThrow("Circular theme reference")
  })

test("missing and noncolor targets still fail", () => {
  const input = definition("dark")
  input.background.base = "$missing"
  expect(() => resolveTheme(input)).toThrow('Theme reference "$missing" was not found')
  input.background.base = "$hue.neutral"
  expect(() => resolveTheme(input)).toThrow("is not a color")
})
