import { describe, expect, test } from "bun:test"
import { DEFAULT_THEME_ID } from "./default-theme"

const context = await Bun.file(new URL("./context.tsx", import.meta.url)).text()

describe("default theme", () => {
  test("the default is sculk, and a sculk theme file ships", async () => {
    expect(DEFAULT_THEME_ID).toBe("sculk")
    const theme = await Bun.file(new URL(`./themes/${DEFAULT_THEME_ID}.json`, import.meta.url)).json()
    expect(theme.id).toBe("sculk")
  })

  test("a missing or unknown stored theme resolves to the default, not oc-2", () => {
    expect(context).toMatch(/return DEFAULT_THEME_ID\n/)
    expect(context).not.toMatch(/knownThemes\(\)\.has\(id\)[^\n]*\)\) return id\n\n  return "oc-2"/)
  })

  test("Reset to default returns to the platform default, and sculk when none is given", () => {
    expect(context).toContain("resetTheme: () => setTheme(props.defaultTheme ?? DEFAULT_THEME_ID)")
    expect(context).not.toContain('props.defaultTheme ?? "oc-2"')
  })

  test("the legacy oc-2 theme stays selectable", () => {
    expect(context).toContain('"oc-2": "OC-2 (legacy)"')
  })
})
