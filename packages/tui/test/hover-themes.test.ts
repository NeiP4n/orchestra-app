import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { resolveThemeDocument, themeModes } from "@orchestra/theme/tui"
import { allThemes, parseTheme, setCustomThemes, setSystemTheme } from "../src/theme"
import { generateSystem, contrastRatio } from "../src/theme/system"
import { hoverBackground, selectionBackground, hoverForeground } from "../src/ui/hover"

function over(color: RGBA, base: RGBA) {
  return RGBA.fromValues(color.r * color.a + base.r * (1 - color.a),
    color.g * color.a + base.g * (1 - color.a), color.b * color.a + base.b * (1 - color.a), 1)
}

function audit() {
  const failures: string[] = []
  for (const [name, source] of Object.entries(allThemes())) {
    const doc = parseTheme(source, name)
    for (const mode of themeModes(doc)) {
      const theme = resolveThemeDocument(doc, mode)
      for (const [surface, view] of [["panel", theme], ["dialog", theme.surface("dialog")]] as const) {
        for (const variant of ["primary", "secondary", "destructive", "selected"] as const) {
          const color = variant === "selected" ? selectionBackground(view) : hoverBackground(view, variant)
          const authoredBase = view.background.raised.base
          // Transparent themes depend on the terminal; use the declared mode's
          // default here, not the hidden zero RGB of a transparent token.
          const base = authoredBase.a < 1
            ? RGBA.fromValues(mode === "light" ? 1 : 0, mode === "light" ? 1 : 0, mode === "light" ? 1 : 0, 1)
            : authoredBase
          const bg = over(color, base)
          const text = contrastRatio(view.text.base, bg)
          if(variant !== "selected") {
            const fg=hoverForeground(view,variant,variant === "destructive" ? view.text.feedback.error.base : undefined)
            if(contrastRatio(fg,bg)<4.5)failures.push(`${name}/${mode}/${surface}/${variant}: hover foreground unreadable`)
          }
          const muted = contrastRatio(view.text.muted, bg)
          const visible = contrastRatio(bg, base)
          if (text < 4.5 || muted < 3 || visible < 1.15)
            failures.push(`${name}/${mode}/${surface}/${variant}: text=${text}, muted=${muted}, surface=${visible}`)
        }
      }
    }
  }
  expect(failures).toEqual([])
}

test("all registered themes retain readable text and visible hover and active-tab surfaces in every mode", audit)

test("custom V1/V2 themes and generated system palettes use the same safe hover path", () => {
  const before = allThemes()
  try {
    setCustomThemes({ "custom-v1": before.cursor, "custom-v2": before.sculk })
    expect(Object.keys(allThemes())).toContain("custom-v1")
    expect(Object.keys(allThemes())).toContain("custom-v2")
    for (const mode of ["light", "dark"] as const) {
      const palette = Array.from({ length: 16 }, (_, i) => i < 8 ? "#777777" : "#dddddd")
      setSystemTheme(generateSystem({ palette, defaultBackground: mode === "light" ? "#ffffff" : "#101820", defaultForeground: mode === "light" ? "#222222" : "#eeeeee" } as never, mode))
      audit()
    }
  } finally { setCustomThemes({}); setSystemTheme(undefined) }
})

test("theme changes invalidate hover memoization and translucent fills are judged after compositing", () => {
  const base = RGBA.fromHex("#101820")
  const theme = { background: { base, raised: { base }, action: { primary: { hovered: RGBA.fromValues(1, 1, 1, 0.01) } } }, text: { base: RGBA.fromHex("#ffffff"), muted: RGBA.fromHex("#aaaaaa") } }
  const first = hoverBackground(theme)
  expect(hoverBackground(theme)).toBe(first)
  expect(contrastRatio(first, base)).toBeGreaterThanOrEqual(1.15)
  theme.background.raised.base = RGBA.fromHex("#eeeeee")
  theme.text.base = RGBA.fromHex("#111111")
  theme.text.muted = RGBA.fromHex("#555555")
  const next = hoverBackground(theme)
  expect(next).not.toBe(first)
  expect(contrastRatio(theme.text.base, next)).toBeGreaterThanOrEqual(4.5)
})
