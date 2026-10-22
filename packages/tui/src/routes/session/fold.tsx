import { createMemo, createSignal, Show } from "solid-js"
import type { RGBA } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { errorHeadline, errorIsLong, foldRows } from "../../util/fold"

// Text that folds after `maxRows` rows and opens on a click.
export function FoldedText(props: { text: string; width: number; maxRows: number; color?: RGBA }) {
  const theme = useTheme()
  const [open, setOpen] = createSignal(false)
  const folded = createMemo(() => foldRows(props.text, props.width, props.maxRows))
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={props.color ?? theme.text.base}>{open() || folded().hidden === 0 ? props.text : folded().head}</text>
      <Show when={folded().hidden > 0}>
        <box onMouseUp={() => setOpen((value) => !value)}>
          <text fg={theme.hue.accent[200]} wrapMode="none" selectable={false}>
            {open() ? "▾ свернуть" : `▸ ещё ${folded().hidden} строк`}
          </text>
        </box>
      </Show>
    </box>
  )
}

// An error as one line with its cause, opening to the full text on a click.
export function ErrorCard(props: { message: string; width: number }) {
  const theme = useTheme()
  const [open, setOpen] = createSignal(false)
  const long = createMemo(() => errorIsLong(props.message, props.width))
  const headline = createMemo(() => errorHeadline(props.message, Math.max(20, props.width - 18)))
  return (
    <Show
      when={long()}
      fallback={
        <text fg={theme.text.feedback.error.base}>✗ {props.message}</text>
      }
    >
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} onMouseUp={() => setOpen((value) => !value)}>
          <text fg={theme.text.feedback.error.base} wrapMode="none" selectable={false}>
            ✗
          </text>
          <text fg={theme.text.feedback.error.base} wrapMode="none" truncate flexShrink={1}>
            {headline()}
          </text>
          <text fg={theme.hue.accent[200]} wrapMode="none" selectable={false} flexShrink={0}>
            {open() ? "▾ свернуть" : "▸ подробнее"}
          </text>
        </box>
        <Show when={open()}>
          <box paddingLeft={2} paddingTop={1}>
            <text fg={theme.text.muted}>{props.message}</text>
          </box>
        </Show>
      </box>
    </Show>
  )
}
