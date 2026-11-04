import { TextAttributes } from "@opentui/core"
import type { JSX, ParentProps } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"

/**
 * The TUI dialog standard: one spacing scale, one header, one close affordance.
 *
 * Two horizontal tiers exist on purpose, matching the dialogs that were already
 * consistent before this standard was written down:
 * - form/custom dialogs (DialogPrompt, DialogAlert, bespoke dialogs) indent
 *   their content by `formX`;
 * - list dialogs (DialogSelect) indent by `listX`, because their rows carry a
 *   selection gutter the form dialogs do not have.
 * Everything else — vertical rhythm, the panel inset, the category rail — uses
 * the single values below instead of each dialog picking its own numbers.
 */
export const dialogSpacing = {
  /** Horizontal padding of form and bespoke dialogs. */
  formX: 2,
  /** Horizontal padding of list dialogs (DialogSelect). */
  listX: 4,
  /** Horizontal padding inside side panels. */
  panelX: 1,
  /** Vertical gap between a dialog header, its body and its footer. */
  gap: 1,
  /** Bottom padding that separates dialog content from the dialog edge. */
  bottom: 1,
} as const

/**
 * The close chip every dialog header shows: the muted `esc` label on the raised
 * surface token, clickable to close. List dialogs already rendered it this way;
 * bespoke dialogs used to show a bare `esc` text instead.
 */
export function DialogCloseChip(props: { onClose?: () => void }) {
  const theme = useTheme().surface("dialog")
  const dialog = useDialog()
  return (
    <box
      backgroundColor={theme.background.raised.base}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
      onMouseUp={() => (props.onClose ?? dialog.clear)()}
    >
      <text fg={theme.text.muted}>esc</text>
    </box>
  )
}

/**
 * The standard dialog header: a bold title on the base text token at the left,
 * the shared close chip at the right. `below` renders under the title row for
 * dialogs that carry a subtitle or a file path there.
 */
export function DialogHeader(props: { title: string; onClose?: () => void; below?: JSX.Element }) {
  const theme = useTheme().surface("dialog")
  return (
    <box>
      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none" truncate flexGrow={1} minWidth={0}>
          {props.title}
        </text>
        <DialogCloseChip onClose={props.onClose} />
      </box>
      {props.below}
    </box>
  )
}

/**
 * The standard outer box for bespoke (non-DialogSelect) dialogs: form-tier
 * horizontal padding, the shared vertical gap, and the shared bottom inset.
 */
export function DialogShell(props: ParentProps) {
  return (
    <box
      paddingLeft={dialogSpacing.formX}
      paddingRight={dialogSpacing.formX}
      gap={dialogSpacing.gap}
      paddingBottom={dialogSpacing.bottom}
    >
      {props.children}
    </box>
  )
}
