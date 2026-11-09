import type { ColorInput } from "@opentui/core"
import { createSignal, type ParentProps } from "solid-js"
import { useTheme } from "../context/theme"
import { hoverBackground, type HoverVariant } from "../ui/hover"

type Props = ParentProps<{
  id?: string
  onClick?: () => void
  disabled?: boolean
  flexShrink?: number
  flexGrow?: number
  minWidth?: number
  maxWidth?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  gap?: number
  flexDirection?: "row" | "column"
  justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | "space-around"
  variant?: HoverVariant
  /** Resting background (for example a focused button); hover still takes over on mouse-over. */
  border?: boolean
  background?: ColorInput
  onHoverChange?: (hovered: boolean) => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}>

// A clickable action gets a background highlight across its entire hit area, not just
// brighter text. Stop pointer events from reaching parent rows so buttons never trigger
// the row's action as well.
export function HoverAction(props: Props) {
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  // A release fires the action only when the press began here and the pointer never
  // left: an abandoned drag across the row must not open anything.
  const [pressed, setPressed] = createSignal(false)

  return (
    <box
      id={props.id}
      border={props.border ? ["left", "right"] : undefined}
      borderStyle="rounded"
      borderColor={theme.text.muted}
      flexShrink={props.flexShrink ?? 0}
      flexGrow={props.flexGrow}
      minWidth={props.minWidth}
      maxWidth={props.maxWidth}
      paddingLeft={props.paddingLeft ?? 0}
      paddingRight={props.paddingRight ?? 0}
      paddingTop={props.paddingTop}
      paddingBottom={props.paddingBottom}
      gap={props.gap}
      flexDirection={props.flexDirection ?? "row"}
      justifyContent={props.justifyContent}
      backgroundColor={hovered() && !props.disabled ? hoverBackground(theme, props.variant) : props.background}
      onMouseOver={() => {
        setHovered(true)
        props.onHoverChange?.(true)
        props.onMouseEnter?.()
      }}
      onMouseOut={() => {
        setHovered(false)
        setPressed(false)
        props.onHoverChange?.(false)
        props.onMouseLeave?.()
      }}
      onMouseDown={(event: { stopPropagation(): void }) => {
        setPressed(true)
        event.stopPropagation()
      }}
      onMouseUp={(event: { stopPropagation(): void }) => {
        event.stopPropagation()
        if (!pressed()) return
        setPressed(false)
        if (!props.disabled) props.onClick?.()
      }}
    >
      {props.children}
    </box>
  )
}
