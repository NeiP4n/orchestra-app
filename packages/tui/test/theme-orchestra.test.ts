import { expect, test } from "bun:test"
import { allThemes, getOrchestraTheme, parseTheme } from "../src/theme"
import { resolveThemeDocument } from "@orchestra/theme/tui"

test("registers the orchestra theme as a native V2 theme and uses it as the system fallback", () => {
  expect(allThemes().orchestra).toBe(getOrchestraTheme())
  expect(parseTheme(getOrchestraTheme()).base).toBeDefined()
})

for (const mode of ["dark", "light"] as const) {
  test(`orchestra ${mode} resolves with outlines instead of fills`, () => {
    const resolved = resolveThemeDocument(getOrchestraTheme(), mode) as unknown as {
      background: { base: unknown; raised: { base: unknown; high: unknown; max: unknown } }
      border: { base: unknown }
    }
    // Raised surfaces are the page background: panels are told apart by their border only.
    expect(resolved.background.raised.base).toEqual(resolved.background.base)
    expect(resolved.background.raised.high).toEqual(resolved.background.base)
    expect(resolved.background.raised.max).toEqual(resolved.background.base)
    expect(resolved.border.base).not.toEqual(resolved.background.base)
  })
}
