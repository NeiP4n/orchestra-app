import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { hoverBackground, type HoverVariant } from "./hover"

/** Visual-only hover. Never intercepts/replaces mouse down/up, dragging, selection or keyboard actions. */
export function createHoverFeedback(variant: HoverVariant = "primary", enabled: () => boolean = () => true) {
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  return {
    active: () => enabled() && hovered(),
    background: () => enabled() && hovered() ? hoverBackground(theme, variant) : undefined,
    onMouseOver: () => setHovered(true),
    onMouseOut: () => setHovered(false),
  }
}
