import { readableColor } from "../theme/system"
import type { ComponentTheme } from "../theme/component"
import { RGBA } from "@opentui/core"

type HoverTheme<T> = {
  background?: {
    base?: T
    raised?: {
      base?: T
      high?: T
    }
    action?: {
      primary?: {
        hovered?: T
      }
      secondary?: {
        hovered?: T
      }
      destructive?: {
        hovered?: T
      }
    }
  }
  text?: {
    base?: T
    muted?: T
  }
  increase?: (color: T, amount: number) => T
}

function composite(color: RGBA, under: RGBA) {
  return RGBA.fromValues(
    color.r * color.a + under.r * (1 - color.a),
    color.g * color.a + under.g * (1 - color.a),
    color.b * color.a + under.b * (1 - color.a), 1,
  )
}

function luminance(color: RGBA) {
  const channel = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function contrast(foreground: RGBA, background: RGBA) {
  const fg = luminance(composite(foreground, background))
  const bg = luminance(background)
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
}

function surfaces<T>(base: T) {
  if (!(base instanceof RGBA)) return []
  return [base]
}

function distinctSurface<T>(surface: T, base: T, theme: HoverTheme<T>, minimum: number) {
  if (surface === base) return false
  if (!(surface instanceof RGBA) || !(base instanceof RGBA)) return true
  if (surface.a <= 0) return false
  return surfaces(base).every((under) => contrast(composite(surface, under), under) >= minimum)
}

function readableSurface<T>(surface: T, base: T | undefined, theme: HoverTheme<T>) {
  if (!(surface instanceof RGBA)) return true
  const under = base instanceof RGBA ? surfaces(base) : [surface]
  return under.every((background) => {
    const rendered = composite(surface, background)
    if (luminance(background) < 0.15 && luminance(rendered) > 0.35) return false
    return [[theme.text?.base, 4.5], [theme.text?.muted, 3]].every(([fg, floor]) =>
      !(fg instanceof RGBA) || contrast(fg, rendered) >= Number(floor))
  })
}

function visibleFallback<T>(base: T, theme: HoverTheme<T>, minimum: number): T {
  if (base instanceof RGBA) {
    // Blend from the theme's own surface toward its text or tonal extremes.
    // No fixed RGB palette: hue and the smallest readable tint follow the theme.
    const text = theme.text?.base
    const poles = [text instanceof RGBA ? text : undefined,
      RGBA.fromValues(0, 0, 0, 1), RGBA.fromValues(1, 1, 1, 1)].filter((x): x is RGBA => !!x)
    const candidates = poles.flatMap((pole) => Array.from({ length: 100 }, (_, index) => {
      const amount = (index + 1) / 100
      const color = RGBA.fromValues(base.r + (pole.r - base.r) * amount,
        base.g + (pole.g - base.g) * amount, base.b + (pole.b - base.b) * amount, 1) as T
      return { color, amount }
    }))
    const readable = candidates.filter(({ color }) =>
      distinctSurface(color, base, theme, minimum) && readableSurface(color, base, theme))
      .sort((a, b) => a.amount - b.amount)[0]
    if (readable) return readable.color
    // A malformed custom palette can make all constraints impossible. Keep the
    // primary label readable first, then maximize surface visibility. Never hide it.
    const score = (color: T) => {
      if (!(color instanceof RGBA)) return 0
      const primary = theme.text?.base
      const textRatio = primary instanceof RGBA ? contrast(primary, color) : 21
      return Math.min(textRatio / 4.5, 1) * 100 + Math.min(contrast(color, base) / minimum, 1)
    }
    return candidates.sort((a, b) => score(b.color) - score(a.color) || a.amount - b.amount)[0]?.color ?? base
  }
  return theme.increase?.(base, 4) ?? base
}

/**
 * Shared hover surface for interactive rows and actions throughout the TUI.
 * Prefer the semantic action-hover token, then the raised-high surface. Some
 * themes leave either token transparent or identical to the panel background;
 * synthesize a subtle neutral highlight rather than making hover invisible.
 */
export type HoverVariant = "primary" | "secondary" | "destructive"

export function hoverBackground<T>(theme: HoverTheme<T>, variant: HoverVariant = "primary"): T {
  return interactiveBackground(theme, variant, 1.15)
}

/** Active tabs get a slightly firmer version of the same theme tint. */
export function selectionBackground<T>(theme: HoverTheme<T>): T {
  return interactiveBackground(theme, "primary", 1.2)
}

function terminalSurface<T>(base: RGBA, text: T) {
  if (base.r || base.g || base.b) return RGBA.fromValues(base.r, base.g, base.b, 1)
  const pole = text instanceof RGBA && luminance(text) < 0.25 ? 1 : 0
  return RGBA.fromValues(pole, pole, pole, 1)
}

const surfaceCache = new WeakMap<object, Map<string, unknown>>()

function interactiveBackground<T>(theme: HoverTheme<T>, variant: HoverVariant, minimum: number): T {
  const colors = [theme.background?.raised?.base, theme.background?.base,
    theme.background?.raised?.high, theme.background?.action?.[variant]?.hovered,
    theme.background?.action?.primary?.hovered, theme.text?.base, theme.text?.muted]
  const key = `${variant}:${minimum}:` + colors.map((color) =>
    color instanceof RGBA ? color.toInts().join(",") : String(color)).join(";")
  let cache = surfaceCache.get(theme)
  if (!cache) surfaceCache.set(theme, cache = new Map())
  if (cache.has(key)) return cache.get(key) as T
  const result = computeBackground(theme, variant, minimum)
  // Bound history when an animated/custom theme changes its colors frequently.
  if (cache.size >= 16) cache.clear()
  cache.set(key, result)
  return result
}

function computeBackground<T>(theme: HoverTheme<T>, variant: HoverVariant, minimum: number): T {
  const background = theme.background
  const raised = background?.raised
  const authoredBase = raised?.base ?? background?.base
  // A zero-alpha default has no terminal RGB information. Use the palette's
  // text polarity for the conventional light/dark terminal default. Nonzero
  // terminal RGB (generated system themes) is preserved even when transparent.
  const base = authoredBase instanceof RGBA && authoredBase.a < 1
    ? terminalSurface(authoredBase, theme.text?.base) as T : authoredBase

  // Prefer the requested semantic action state, then shared theme surfaces.
  // A primary hover is the safe neutral fallback for variants a theme omits.
  const action = background?.action?.[variant]?.hovered
  for (const candidate of [action, raised?.high, background?.action?.primary?.hovered]) {
    if (candidate !== undefined && (base === undefined || distinctSurface(candidate, base, theme, minimum)) && readableSurface(candidate, base, theme)) return candidate
  }

  if (base !== undefined) {
    const increased = theme.increase?.(base, 4)
    if (increased !== undefined && distinctSurface(increased, base, theme, minimum) && readableSurface(increased, base, theme)) return increased
    return visibleFallback(base, theme, minimum)
  }

  const fallback = theme.text?.muted ?? theme.text?.base
  if (fallback !== undefined) return fallback
  throw new Error("Cannot determine hover background: theme has no available color")
}

/** Pair a label with the actual safe hover surface, not its unrelated authored action token. */
export function hoverForeground(theme: HoverTheme<RGBA>, variant: HoverVariant = "primary", preferred = theme.text?.base): RGBA {
  const background = hoverBackground(theme, variant)
  if (preferred && contrast(preferred, background) >= 4.5) return preferred
  if (theme.text?.base && contrast(theme.text.base, background) >= 4.5) return theme.text.base
  const black = RGBA.fromValues(0, 0, 0, 1), white = RGBA.fromValues(1, 1, 1, 1)
  return contrast(black, background) > contrast(white, background) ? black : white
}

/** Modal state labels are repaired against their own authored state surface. */
export function modalButtonForeground(theme: ComponentTheme, variant: "primary" | "secondary" | "destructive", state: "base" | "hovered" | "focused" | "selected" | "pressed" | "disabled") {
 const foreground=(theme.text.action[variant] as unknown as Record<string,RGBA>)[state]
 const background=(theme.background.action[variant] as unknown as Record<string,RGBA>)[state]
 const under=theme.background.base.a < 1 ? terminalSurface(theme.background.base,theme.text.base) : theme.background.base
 return readableColor(foreground,composite(background,under),state === "disabled" ? 3.05 : 4.55)
}
