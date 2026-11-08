import { HoverAction } from "../component/hover-action"
import { TextAttributes } from "@opentui/core"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"

export type DialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
}

export function DialogAlert(props: DialogAlertProps) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: "Confirm alert",
        group: "Dialog",
        run: () => {
          props.onConfirm?.()
          dialog.clear()
        },
      },
    ],
  }))
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          {props.title}
        </text>
        <HoverAction paddingLeft={1} paddingRight={1} onClick={() => dialog.clear()}>
          <text fg={theme.text.muted}>esc</text>
        </HoverAction>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.text.muted}>{props.message}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <HoverAction
          paddingLeft={3}
          paddingRight={3}
          background={theme.background.action.primary.focused}
          onClick={() => {
            props.onConfirm?.()
            dialog.clear()
          }}
        >
          <text fg={theme.text.action.primary.focused}>ok</text>
        </HoverAction>
      </box>
    </box>
  )
}
