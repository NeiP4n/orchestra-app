import { describe, expect, test } from "bun:test"
import { buildThemeCss } from "./loader"
import type { ResolvedTheme } from "./resolve"
import type { ResolvedV2Theme } from "./v2/resolve"

// buildThemeCss must emit dark tokens under the app color-scheme attribute
// AND under the OS media query, with the same dark values in both —
// otherwise a dark app scheme on a light OS renders black text on a black
// background (see theme.test.ts).

const light = { "text-strong": "#171717" } as unknown as ResolvedTheme
const dark = { "text-strong": "rgba(255, 255, 255, 0.936)" } as unknown as ResolvedTheme
const lightV2 = { "v2-text-text-base": "#1a1a1a" } as unknown as ResolvedV2Theme
const darkV2 = { "v2-text-text-base": "#eeeeee" } as unknown as ResolvedV2Theme

describe("buildThemeCss", () => {
  test("default theme: dark tokens under the attribute and the OS fallback", () => {
    const css = buildThemeCss(light, dark, lightV2, darkV2, "oc-2")
    expect(css).toContain(':root[data-color-scheme="dark"]')
    expect(css).toContain(':root:not([data-color-scheme="light"])')
    expect(css).toContain("--text-strong: rgba(255, 255, 255, 0.936);")
    expect(css).toContain("--v2-text-text-base: #eeeeee;")
    // The dark values appear once per dark block (attribute + media).
    expect(css.split("--text-strong: rgba(255, 255, 255, 0.936);").length - 1).toBe(2)
    // The light values appear once.
    expect(css.split("--text-strong: #171717;").length - 1).toBe(1)
  })

  test("custom theme: dark tokens scoped to the theme id", () => {
    const css = buildThemeCss(light, dark, lightV2, darkV2, "sculk")
    expect(css).toContain('html[data-theme="sculk"][data-color-scheme="dark"]')
    expect(css).toContain('html[data-theme="sculk"]:not([data-color-scheme="light"])')
    expect(css).not.toContain(":root[data-color-scheme")
  })
})
