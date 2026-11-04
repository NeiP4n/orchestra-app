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

function distinctSurface<T>(surface: T, base: T) {
  if (surface === base) return false
  if (!(surface instanceof RGBA) || !(base instanceof RGBA)) return true
  if (surface.a <= 0) return false
  const r = surface.r * surface.a + base.r * (1 - surface.a)
  const g = surface.g * surface.a + base.g * (1 - surface.a)
  const b = surface.b * surface.a + base.b * (1 - surface.a)
  return Math.hypot(r - base.r, g - base.g, b - base.b) >= 0.045
}

function luminance(color: RGBA) {
  const channel = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function contrast(foreground: RGBA, background: RGBA) {
  const fg = luminance(foreground)
  const bg = luminance(background)
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
}

function visibleFallback<T>(base: T, theme: HoverTheme<T>): T {
  if (base instanceof RGBA) {
    const foregrounds = [theme.text?.base, theme.text?.muted].filter(
      (color) => color instanceof RGBA && color.a >= 1,
    ) as RGBA[]
    const candidates = [0, 1].flatMap((pole) =>
      Array.from({ length: 87 }, (_, index) => {
        const amount = (index + 14) / 100
        const color = RGBA.fromValues(
          base.r + (pole - base.r) * amount,
          base.g + (pole - base.g) * amount,
          base.b + (pole - base.b) * amount,
          1,
        )
        const minimum = foregrounds.length
          ? Math.min(...foregrounds.map((foreground) => contrast(foreground, color)))
          : 0
        return { color, amount, minimum }
      }),
    )
    // Prefer the smallest visible tint that keeps both primary and muted text readable.
    const readable = candidates
      .filter((candidate) => candidate.minimum >= 3)
      .sort((a, b) => a.amount - b.amount)[0]
    if (readable) return readable.color as T
    // Extremely unusual palettes may have conflicting text hues; choose the direction
    // that maximizes the weakest text contrast rather than hiding one of the labels.
    const safest = candidates.sort((a, b) => b.minimum - a.minimum || a.amount - b.amount)[0]
    return (safest?.color ?? base) as T
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
  const background = theme.background
  const raised = background?.raised
  const base = raised?.base ?? background?.base

  // Prefer the requested semantic action state, then shared theme surfaces.
  // A primary hover is the safe neutral fallback for variants a theme omits.
  const action = background?.action?.[variant]?.hovered
  for (const candidate of [action, raised?.high, background?.action?.primary?.hovered]) {
    if (candidate !== undefined && (base === undefined || distinctSurface(candidate, base))) return candidate
  }

  if (base !== undefined) {
    const increased = theme.increase?.(base, 4)
    if (increased !== undefined && distinctSurface(increased, base)) return increased
    return visibleFallback(base, theme)
  }

  const fallback = theme.text?.muted ?? theme.text?.base
  if (fallback !== undefined) return fallback
  throw new Error("Cannot determine hover background: theme has no available color")
}
