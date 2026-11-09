import { createHoverFeedback } from "./hover-feedback"
import { TextAttributes } from "@opentui/core"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"

export function DialogExportResult(props: { path: string; onClose?: () => void }) {
  const dialog = useDialog()
  const closeHover = createHoverFeedback("secondary")
  const buttonHover = createHoverFeedback()
  const theme = useTheme().surface("dialog")

  const close = () => {
    props.onClose?.()
    dialog.clear()
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: "Close export result",
        group: "Dialog",
        run: close,
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          Session exported
        </text>
        <text fg={theme.text.muted} bg={closeHover.background()} onMouseOver={closeHover.onMouseOver} onMouseOut={closeHover.onMouseOut} onMouseUp={close}>
          esc
        </text>
      </box>
      <box>
        <text fg={theme.text.base}>{props.path}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={buttonHover.background() ?? theme.background.base}
          onMouseOver={buttonHover.onMouseOver}
          onMouseOut={buttonHover.onMouseOut}
          onMouseUp={close}
        >
          <text fg={theme.text.base}>[ Close ]</text>
        </box>
      </box>
    </box>
  )
}

DialogExportResult.show = (dialog: DialogContext, path: string) =>
  new Promise<void>((resolve) => {
    dialog.replace(() => <DialogExportResult path={path} onClose={resolve} />, resolve)
  })
