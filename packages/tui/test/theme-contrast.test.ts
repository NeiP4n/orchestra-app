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
  { name: "syntax.comment on background.base", fg: (t) => t.syntax.comment, bg: (t) => t.background.base, floor: 3.5 },
  { name: "markdown.blockQuote on background.base", fg: (t) => t.markdown.blockQuote, bg: (t) => t.background.base, floor: 3.5 },
  { name: "feedback.error.muted on background.base", fg: (t) => t.text.feedback.error.muted, bg: (t) => t.background.base, floor: 3.0 },
  { name: "feedback.warning.muted on background.base", fg: (t) => t.text.feedback.warning.muted, bg: (t) => t.background.base, floor: 3.0 },
  { name: "feedback.success.muted on background.base", fg: (t) => t.text.feedback.success.muted, bg: (t) => t.background.base, floor: 3.0 },
  { name: "feedback.info.muted on background.base", fg: (t) => t.text.feedback.info.muted, bg: (t) => t.background.base, floor: 3.0 },
]

// State text (buttons, form controls, feedback banners) renders on its OWN
// state background, not the page surface — the pairs the plain-surface lists
// above cannot see. A translucent state background shows what is beneath the
// control, so it is judged against the composited surface over the plain
// backgrounds, exactly as the resolver repairs it.
const statePairs: Array<{
  name: string
  fg: (t: Resolved) => RGBA | undefined
  bg: (t: Resolved) => RGBA | undefined
  floor: number
}> = []
for (const variant of ["primary", "secondary", "destructive"] as const)
  for (const state of ["base", "hovered", "focused", "selected", "pressed", "disabled"] as const)
    statePairs.push({
      name: `action.${variant}.${state} on its background`,
      fg: (t) => (t.text.action[variant] as unknown as Record<string, RGBA>)[state],
      bg: (t) => (t.background.action[variant] as unknown as Record<string, RGBA>)[state],
      floor: state === "disabled" ? 3.0 : 4.5,
    })
for (const state of ["base", "hovered", "focused", "selected", "pressed", "disabled"] as const)
  statePairs.push({
    name: `formfield.${state} on its background`,
    fg: (t) => (t.text.formfield as unknown as Record<string, RGBA>)[state],
    bg: (t) => (t.background.formfield as unknown as Record<string, RGBA>)[state],
    floor: state === "disabled" ? 3.0 : 4.5,
  })
for (const variant of ["primary", "secondary", "destructive"] as const)
  statePairs.push({
    name: `action.${variant}.base on its hovered background`,
    fg: (t) => (t.text.action[variant] as unknown as Record<string, RGBA>).base,
    bg: (t) => (t.background.action[variant] as unknown as Record<string, RGBA>).hovered,
    floor: 3.0,
  })
for (const kind of ["error", "warning", "success", "info"] as const) {
  statePairs.push({
    name: `feedback.${kind}.base on its background`,
    fg: (t) => t.text.feedback[kind].base,
    bg: (t) => t.background.feedback[kind].base,
    floor: 4.5,
  })
  statePairs.push({
    name: `feedback.${kind}.muted on its background`,
    fg: (t) => t.text.feedback[kind].muted,
    bg: (t) => t.background.feedback[kind].base,
    floor: 3.0,
  })
}
statePairs.push(
  // Generic labels are used on hover backgrounds by rows, chips and panel links.
  // Check both the raised overlay and the action hover when those surfaces are translucent.
  { name: "text.base on raised.high", fg: (t) => t.text.base, bg: (t) => t.background.raised.high, floor: 3.0 },
  { name: "text.muted on raised.high", fg: (t) => t.text.muted, bg: (t) => t.background.raised.high, floor: 3.0 },
  { name: "text.base on action.primary.hovered", fg: (t) => t.text.base, bg: (t) => t.background.action.primary.hovered, floor: 3.0 },
  { name: "text.muted on action.primary.hovered", fg: (t) => t.text.muted, bg: (t) => t.background.action.primary.hovered, floor: 3.0 },
  { name: "diff.lineNumber on added background", fg: (t) => t.diff.lineNumber.text, bg: (t) => t.diff.lineNumber.background.added, floor: 3.0 },
  { name: "diff.lineNumber on removed background", fg: (t) => t.diff.lineNumber.text, bg: (t) => t.diff.lineNumber.background.removed, floor: 3.0 },
  { name: "backend.bash on background.base", fg: (t) => t.text.backend?.bash, bg: (t) => t.background.base, floor: 3.0 },
  { name: "backend.nu on background.base", fg: (t) => t.text.backend?.nu, bg: (t) => t.background.base, floor: 3.0 },
  { name: "backend.pwsh on background.base", fg: (t) => t.text.backend?.pwsh, bg: (t) => t.background.base, floor: 3.0 },
  { name: "neural.signal on background.base", fg: (t) => t.text.neural?.signal, bg: (t) => t.background.base, floor: 3.0 },
  { name: "neural.synapse on background.base", fg: (t) => t.text.neural?.synapse, bg: (t) => t.background.base, floor: 3.0 },
  { name: "neural.spark on background.base", fg: (t) => t.text.neural?.spark, bg: (t) => t.background.base, floor: 3.0 },
  { name: "neural.dormant on background.base", fg: (t) => t.text.neural?.dormant, bg: (t) => t.background.base, floor: 3.0 },
  { name: "markdown.codeBlock on raised.base", fg: (t) => t.markdown.codeBlock, bg: (t) => t.background.raised.base, floor: 4.5 },
)

function renderedSurfaces(theme: Resolved, background: RGBA): RGBA[] {
  if (background.a >= 1) return [background]
  // A transparent theme background defers to the terminal entirely; the
  // resolver cannot repair against it and neither can this test judge it.
  if (theme.background.base.a < 1) return []
  const over = (under: RGBA) =>
    ({
      r: background.r * background.a + under.r * (1 - background.a),
      g: background.g * background.a + under.g * (1 - background.a),
      b: background.b * background.a + under.b * (1 - background.a),
      a: 1,
    }) as RGBA
  return [over(theme.background.base), over(theme.background.raised.base)]
}

function surfaceRatio(foreground: RGBA, surface: RGBA) {
  const fg = luminance(foreground, surface)
  const bg = luminance(surface)
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
}

test("every built-in theme resolves with readable state text in every mode", () => {
  const failures: string[] = []
  for (const [name, source] of Object.entries(allThemes())) {
    if (name === "system") continue
    const document = parseTheme(source as never, name)
    for (const mode of themeModes(document)) {
      const theme = resolveThemeDocument(document, mode)
      for (const pair of statePairs) {
        const foreground = pair.fg(theme)
        const background = pair.bg(theme)
        if (!foreground || !background) continue
        for (const surface of renderedSurfaces(theme, background)) {
          const value = surfaceRatio(foreground, surface)
          if (value < pair.floor)
            failures.push(`${name}/${mode}: ${pair.name} is ${value.toFixed(2)}:1, expected at least ${pair.floor}:1`)
        }
      }
    }
  }
  expect(failures).toEqual([])
})

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
