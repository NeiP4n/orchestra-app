import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { hoverBackground, hoverForeground } from "../ui/hover"

export function PluginRouteMissing(props: { id: string; name: string; onHome: () => void }) {
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)

  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
      <text fg={theme.text.feedback.warning.base}>
        Unknown plugin route: {props.id}/{props.name}
      </text>
      <box
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={hovered() ? hoverBackground(theme) : undefined}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={(event) => {
          event.stopPropagation()
          props.onHome()
        }}
      >
        <text fg={hovered() ? hoverForeground(theme, "primary") : theme.text.action.primary.base}>go home</text>
      </box>
    </box>
  )
}
