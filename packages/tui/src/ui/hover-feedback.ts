import { createSignal } from "solid-js"
import type { ComponentTheme } from "../theme/component"
import { useTheme } from "../context/theme"
import { hoverBackground, type HoverVariant } from "./hover"

/** Visual-only hover. Never intercepts/replaces mouse down/up, dragging, selection or keyboard actions. */
export function createHoverFeedback(variant: HoverVariant = "primary", enabled: () => boolean = () => true, explicitTheme?: ComponentTheme) {
  const theme = explicitTheme ?? useTheme()
  const [hovered, setHovered] = createSignal(false)
  return {
    active: () => enabled() && hovered(),
    background: () => enabled() && hovered() ? hoverBackground(theme, variant) : undefined,
    onMouseOver: () => setHovered(true),
    onMouseOut: () => setHovered(false),
  }
}
