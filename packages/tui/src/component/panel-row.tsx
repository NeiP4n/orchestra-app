import { tint } from "../theme/color"
import { useT } from "../util/i18n"
import type { StateFeedback } from "../ui/state-feedback"
import { Show, type JSX } from "solid-js"
import { useTheme } from "../context/theme"
import { hoverBackground } from "../ui/hover"

// One clickable line of the left panel. Hover is shared by the panel so only one
// row lights up at a time, and the selected row marks where the user is.
export function Row(props: {
  id: string
  hover: () => string | undefined
  setHover: (id: string | undefined) => void
  selected?: boolean
  feedback?: StateFeedback
  onClick: () => void
  children: JSX.Element
}) {
  const theme = useTheme()
  const t = useT()
  // A selected row can contain ordinary body/muted text, not action-state text.
  // Use the same neutral surface as hover instead of the focused action fill.
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={
        props.selected || props.hover() === props.id
          ? hoverBackground(theme)
          : props.feedback?.flash || (props.feedback?.phase === "waiting" && props.feedback.pulse > 0)
            ? tint(theme.background.raised.base, theme.text.feedback.warning.base, props.feedback.flash ? 0.14 : 0.04 + props.feedback.pulse * 0.08)
            : undefined
      }
      onMouseOver={() => props.setHover(props.id)}
      onMouseOut={() => props.setHover(undefined)}
      onMouseUp={props.onClick}
    >
      {props.children}
      <Show when={props.feedback?.phase === "waiting" || props.feedback?.phase === "error" || props.feedback?.phase === "paused"}>
        <text flexShrink={0} fg={props.feedback?.phase === "error" ? theme.text.feedback.error.base : theme.text.feedback.warning.base}>{props.feedback?.phase === "waiting" ? ` · ${t("waiting for answer")}` : props.feedback?.phase === "error" ? ` · ${t("error")}` : ` · ${t("paused")}`}</text>
      </Show>
    </box>
  )
}
