import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import type { RGBA } from "@opentui/core"
import { parseThemeDocument, resolveThemeDocument, themeModes } from "../src/tui/index.js"

// Every bundled v2 theme, both modes: readable text floors and well-formed colour scales.
const directory = new URL("../../tui/src/theme/assets/v2/", import.meta.url)
const names = readdirSync(directory)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.replace(/\.json$/, ""))
  .sort()

const themes = await Promise.all(
  names.map(async (name) => ({
    name,
    document: parseThemeDocument(await Bun.file(new URL(`${name}.json`, directory)).json(), name),
  })),
)
const cases = themes.flatMap(({ name, document }) => themeModes(document).map((mode) => ({ name, mode, document })))

const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4))
const luminance = (color: RGBA) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
const contrast = (a: RGBA, b: RGBA) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}
// Hue angle in degrees, 0-360.
const hue = (color: RGBA) => {
  const { r, g, b } = color
  const max = Math.max(r, g, b)
  const delta = max - Math.min(r, g, b)
  if (delta === 0) return 0
  const angle = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return (angle * 60 + 360) % 360
}
const steps = [100, 200, 300, 400, 500, 600, 700, 800, 900]
const scale = (theme: ReturnType<typeof resolveThemeDocument>, name: "orange" | "cyan" | "accent" | "interactive") =>
  steps.map((step) => (theme.hue[name] as unknown as Record<number, RGBA>)[step]!)

test("at least the orchestra and sculk themes are bundled", () => {
  expect(names).toContain("orchestra")
  expect(names).toContain("sculk")
})

describe.each(cases)("$name $mode", ({ document, mode }) => {
  const theme = resolveThemeDocument(document, mode)

  test("text is at least 7:1 on the background", () => {
    expect(contrast(theme.text.base, theme.background.base)).toBeGreaterThanOrEqual(7)
  })

  test("muted text is at least 4.5:1 on the background", () => {
    expect(contrast(theme.text.muted, theme.background.base)).toBeGreaterThanOrEqual(4.5)
  })

  test("the hint layer (neutral 400) is at least 3:1 on the background", () => {
    expect(contrast(theme.hue.neutral[400], theme.background.base)).toBeGreaterThanOrEqual(3)
  })

  test.each(["orange", "cyan", "accent", "interactive"] as const)(
    "the %s scale changes monotonically in lightness",
    (name) => {
      const lightness = scale(theme, name).map(luminance)
      const falling = lightness.every((value, index) => index === 0 || value <= lightness[index - 1]! + 1e-9)
      const rising = lightness.every((value, index) => index === 0 || value >= lightness[index - 1]! - 1e-9)
      expect(falling || rising).toBe(true)
    },
  )

  test("the orange scale stays in the orange and amber family", () => {
    for (const color of scale(theme, "orange")) {
      const angle = hue(color)
      expect(angle).toBeGreaterThanOrEqual(25)
      expect(angle).toBeLessThanOrEqual(65)
    }
  })

  test("the lightest cyan step keeps the hue of the family", () => {
    const [lightest, base] = scale(theme, "cyan")
    expect(Math.abs(hue(lightest!) - hue(base!))).toBeLessThanOrEqual(15)
  })
})
