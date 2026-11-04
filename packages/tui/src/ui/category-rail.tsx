import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show, type JSX } from "solid-js"
import { useTheme } from "../context/theme"
import { Locale } from "../util/locale"
import { hoverBackground } from "./hover"

// Below this terminal width the rail would squeeze the list beside it, so dialogs hide it and keep
// the keyboard category switch.
const RAIL_MIN_TERMINAL_WIDTH = 100

export function useCategoryRailVisible() {
  const dimensions = useTerminalDimensions()
  return () => dimensions().width >= RAIL_MIN_TERMINAL_WIDTH
}

export type CategoryRailItem = {
  id: string
  label: string
  count?: number
}

/**
 * Vertical category list for dialogs that hold many entries: the rail picks the group, the list
 * beside it shows only that group. Pass `footer` for anything pinned under the categories.
 */
export function CategoryRail(props: {
  items: readonly CategoryRailItem[]
  selected: string
  onSelect: (id: string) => void
  width?: number
  footer?: JSX.Element
}) {
  const theme = useTheme().surface("dialog")
  const visible = useCategoryRailVisible()
  const [hovered, setHovered] = createSignal<string>()
  const width = () => props.width ?? 26
  // The row gives the label what is left after the rail's own padding and the count; a longer label
  // is cut with an ellipsis instead of running into the count ("Google Antigra13").
  const label = (item: CategoryRailItem) =>
    Locale.truncate(item.label, Math.max(4, width() - 4 - (item.count === undefined ? 0 : String(item.count).length + 1)))
  return (
    <Show when={visible()}>
    <box
      flexDirection="column"
      flexShrink={0}
      width={width()}
      paddingLeft={1}
      paddingTop={1}
      justifyContent="space-between"
      border={["right"]}
      borderColor={theme.border.base}
    >
      <box flexDirection="column">
        <For each={props.items}>
          {(item) => {
            const active = () => props.selected === item.id
            return (
              <box
                flexDirection="row"
                justifyContent="space-between"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  active()
                    ? theme.background.action.primary.focused
                    : hovered() === item.id
                      ? hoverBackground(theme)
                      : undefined
                }
                onMouseOver={() => setHovered(item.id)}
                onMouseOut={() => setHovered(undefined)}
                onMouseDown={(event) => event.stopPropagation()}
                onMouseUp={(event) => {
                  event.stopPropagation()
                  props.onSelect(item.id)
                }}
              >
                <text
                  fg={active() ? theme.text.action.primary.focused : theme.text.base}
                  attributes={active() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {label(item)}
                </text>
                {item.count === undefined ? null : (
                  <text fg={active() ? theme.text.action.primary.focused : theme.text.muted} wrapMode="none">
                    {String(item.count)}
                  </text>
                )}
              </box>
            )
          }}
        </For>
      </box>
      {props.footer}
    </box>
    </Show>
  )
}
