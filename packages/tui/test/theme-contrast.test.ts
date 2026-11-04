import { expect, test } from "bun:test"
import { allThemes, parseTheme } from "../src/theme"
import { resolveThemeDocument, themeModes } from "@orchestra/theme/tui"
import type { RGBA } from "@opentui/core"

// Readability floors for resolved themes, checked through the production
// pipeline (registry -> V1 migration -> document resolution) for every
// built-in theme in every mode it declares. The resolver repairs tokens
// that fall under these floors (see ensureReadable in @orchestra/theme);
// this test is the regression net that keeps a future theme or migration
// change from shipping invisible text again.
//
// Floors mirror the resolver's: primary text 4.5:1 (WCAG normal text),
// subdued roles 3.5:1, muted variants and overlay surfaces 3.0:1 — and no
// measured text pair may fall under 3.0:1 at all.

function luminance(color: RGBA, over?: RGBA) {
  let [r, g, b] = [color.r, color.g, color.b]
  if (over && color.a < 1) {
    r = r * color.a + over.r * (1 - color.a)
    g = g * color.a + over.g * (1 - color.a)
    b = b * color.a + over.b * (1 - color.a)
  }
  const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(foreground: RGBA, background: RGBA, mode: string) {
  // A transparent background shows the terminal's own background; judge it
  // against the mode's expected default, as a user's terminal would render.
  const surface =
    background.a < 1
      ? ({ r: mode === "light" ? 1 : 0, g: mode === "light" ? 1 : 0, b: mode === "light" ? 1 : 0, a: 1 } as RGBA)
      : background
  const fg = luminance(foreground, surface)
  const bg = luminance(surface)
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
}

type Resolved = ReturnType<typeof resolveThemeDocument>

const primary: Array<{ name: string; fg: (t: Resolved) => RGBA; bg: (t: Resolved) => RGBA }> = [
  { name: "text.base on background.base", fg: (t) => t.text.base, bg: (t) => t.background.base },
  { name: "text.base on raised.base", fg: (t) => t.text.base, bg: (t) => t.background.raised.base },
  { name: "text.muted on background.base", fg: (t) => t.text.muted, bg: (t) => t.background.base },
  { name: "text.muted on raised.base", fg: (t) => t.text.muted, bg: (t) => t.background.raised.base },
  { name: "markdown.text on background.base", fg: (t) => t.markdown.text, bg: (t) => t.background.base },
  { name: "markdown.code on background.base", fg: (t) => t.markdown.code, bg: (t) => t.background.base },
  { name: "markdown.code on raised.base", fg: (t) => t.markdown.code, bg: (t) => t.background.raised.base },
  { name: "markdown.linkText on background.base", fg: (t) => t.markdown.linkText, bg: (t) => t.background.base },
  { name: "syntax.punctuation on background.base", fg: (t) => t.syntax.punctuation, bg: (t) => t.background.base },
  { name: "diff.context on its background", fg: (t) => t.diff.text.context, bg: (t) => t.diff.background.context },
  { name: "feedback.error on background.base", fg: (t) => t.text.feedback.error.base, bg: (t) => t.background.base },
  { name: "feedback.warning on background.base", fg: (t) => t.text.feedback.warning.base, bg: (t) => t.background.base },
  { name: "feedback.success on background.base", fg: (t) => t.text.feedback.success.base, bg: (t) => t.background.base },
  { name: "feedback.info on background.base", fg: (t) => t.text.feedback.info.base, bg: (t) => t.background.base },
]

const subdued: Array<{ name: string; fg: (t: Resolved) => RGBA; bg: (t: Resolved) => RGBA; floor: number }> = [
  { name: "text.muted on raised.high", fg: (t) => t.text.muted, bg: (t) => t.background.raised.high, floor: 3.0 },
  { name: "text.base on raised.high", fg: (t) => t.text.base, bg: (t) => t.background.raised.high, floor: 3.0 },
  { name: "syntax.comment on background.base", fg: (t) => t.syntax.comment, bg: (t) => t.background.base, floor: 3.5 },
  { name: "markdown.blockQuote on background.base", fg: (t) => t.markdown.blockQuote, bg: (t) => t.background.base, floor: 3.5 },
  { name: "feedback.error.muted on background.base", fg: (t) => t.text.feedback.error.muted, bg: (t) => t.background.base, floor: 3.0 },
  { name: "feedback.warning.muted on background.base", fg: (t) => t.text.feedback.warning.muted, bg: (t) => t.background.base, floor: 3.0 },
  { name: "feedback.success.muted on background.base", fg: (t) => t.text.feedback.success.muted, bg: (t) => t.background.base, floor: 3.0 },
  { name: "feedback.info.muted on background.base", fg: (t) => t.text.feedback.info.muted, bg: (t) => t.background.base, floor: 3.0 },
]

test("every built-in theme resolves with readable text in every mode", () => {
  const failures: string[] = []
  for (const [name, source] of Object.entries(allThemes())) {
    if (name === "system") continue
    const document = parseTheme(source as never, name)
    for (const mode of themeModes(document)) {
      const theme = resolveThemeDocument(document, mode)
      // The resolver can only repair against an opaque surface; a transparent
      // background defers to the terminal, so the strict floors apply there
      // only through the composited ratio in the never-disappear check below.
      const opaque = theme.background.base.a >= 1
      if (opaque) {
        for (const pair of primary) {
          const value = ratio(pair.fg(theme), pair.bg(theme), mode)
          if (value < 4.5) failures.push(`${name}/${mode}: ${pair.name} is ${value.toFixed(2)}:1, expected at least 4.5:1`)
        }
        for (const pair of subdued) {
          const value = ratio(pair.fg(theme), pair.bg(theme), mode)
          if (value < pair.floor)
            failures.push(`${name}/${mode}: ${pair.name} is ${value.toFixed(2)}:1, expected at least ${pair.floor}:1`)
        }
      }
      for (const pair of [...primary, ...subdued]) {
        const value = ratio(pair.fg(theme), pair.bg(theme), mode)
        if (value < 3.0) failures.push(`${name}/${mode}: ${pair.name} is ${value.toFixed(2)}:1, expected at least 3:1`)
      }
    }
  }
  expect(failures).toEqual([])
})
