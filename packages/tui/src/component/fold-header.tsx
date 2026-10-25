import type { JSX } from "solid-js"
import { useTheme } from "../context/theme"
import { hoverBackground } from "../ui/hover"
import { createSignal } from "solid-js"

/**
 * The title row of a sidebar section that folds: an arrow, the title, and a one-line summary that stays visible while
 * folded. Clicking anywhere on the row folds or unfolds the section.
 */
export function FoldHeader(props: {
  id: string
  title: string
  summary?: JSX.Element
  open: boolean
  onToggle: () => void
}) {
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)

  return (
    <box
      id={props.id}
      flexDirection="row"
      justifyContent="space-between"
      gap={1}
      backgroundColor={hovered() ? hoverBackground(theme) : undefined}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseUp={(event) => {
        event.stopPropagation()
        props.onToggle()
      }}
    >
      <text fg={theme.text.base} flexShrink={0}>
        {props.open ? "▼ " : "▶ "}
        <b>{props.title}</b>
      </text>
      <box flexShrink={1} minWidth={0}>
        {props.summary}
      </box>
    </box>
  )
}
