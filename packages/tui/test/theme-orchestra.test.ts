import { expect, test } from "bun:test"
import { allThemes, getOrchestraTheme, parseTheme } from "../src/theme"
import { resolveThemeDocument } from "@orchestra/theme/tui"

test("registers the orchestra theme as a native V2 theme and uses it as the system fallback", () => {
  expect(allThemes().orchestra).toBe(getOrchestraTheme())
  expect(parseTheme(getOrchestraTheme()).base).toBeDefined()
})

for (const mode of ["dark", "light"] as const) {
  test(`orchestra ${mode} resolves with outlines and one tint for hover`, () => {
    const resolved = resolveThemeDocument(getOrchestraTheme(), mode) as unknown as {
      background: { base: unknown; raised: { base: unknown; high: unknown; max: unknown } }
      border: { base: unknown }
    }
    // Panels are the page background and are told apart by their border only. The high surface is
    // the one tint: hover and pop-up menus need it to stay visible against the page.
    expect(resolved.background.raised.base).toEqual(resolved.background.base)
    expect(resolved.background.raised.high).not.toEqual(resolved.background.base)
    expect(resolved.background.raised.max).toEqual(resolved.background.base)
    expect(resolved.border.base).not.toEqual(resolved.background.base)
  })
}
