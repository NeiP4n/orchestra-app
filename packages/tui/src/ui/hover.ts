type HoverTheme<T> = {
  background?: {
    base?: T
    raised?: {
      base?: T
      high?: T
    }
  }
  text?: {
    base?: T
    muted?: T
  }
  increase?: (color: T, amount: number) => T
}

/**
 * Shared hover surface for interactive rows and actions throughout the TUI.
 * Prefer the theme's raised-high token so different panels render the same
 * highlight; minimal/plugin themes can fall back to their available color.
 */
export function hoverBackground<T>(theme: HoverTheme<T>): T {
  const background = theme.background
  const raised = background?.raised
  if (raised?.high !== undefined) return raised.high
  const base = raised?.base ?? background?.base
  if (base !== undefined) return theme.increase?.(base, 4) ?? base
  const fallback = theme.text?.muted ?? theme.text?.base
  if (fallback !== undefined) return fallback
  throw new Error("Cannot determine hover background: theme has no available color")
}
