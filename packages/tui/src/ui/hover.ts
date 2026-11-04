import { RGBA } from "@opentui/core"
import { tint } from "../theme/color"

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
  return Math.hypot(surface.r - base.r, surface.g - base.g, surface.b - base.b) >= 0.045
}

function visibleFallback<T>(base: T, theme: HoverTheme<T>): T {
  if (base instanceof RGBA) {
    const luminance = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b
    const pole = luminance < 0.5 ? RGBA.fromInts(255, 255, 255) : RGBA.fromInts(0, 0, 0)
    return tint(base, pole, 0.14) as T
  }
  return theme.increase?.(base, 4) ?? base
}

/**
 * Shared hover surface for interactive rows and actions throughout the TUI.
 * Use the authored raised-high token when it is actually distinct from the
 * panel background. Some custom themes map both tokens to the same color; in
 * that case synthesize a subtle neutral highlight so hover never becomes inert.
 */
export function hoverBackground<T>(theme: HoverTheme<T>): T {
  const background = theme.background
  const raised = background?.raised
  const base = raised?.base ?? background?.base

  // Prefer the semantic action-hover token, then the shared raised surface.
  // Both are theme-owned; the fallback below is only for themes whose tokens collapse.
  for (const candidate of [background?.action?.primary?.hovered, raised?.high]) {
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
