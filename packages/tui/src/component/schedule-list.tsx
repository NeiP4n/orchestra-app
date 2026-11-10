import { createEffect, createSignal, onCleanup } from "solid-js"
import { ScheduleView } from "@orchestra/core/schedule-view"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { HoverAction } from "./hover-action"
import { DialogSchedules } from "./dialog-schedules"
import { scheduleEllipsis } from "../util/schedule-list"

/** One quiet entry point. Details and destructive actions belong in the central window. */
export function ScheduleList(props: { sessionID: string; width?: number }) {
  const theme = useTheme(),
    dialog = useDialog()
  const [items, setItems] = createSignal<ScheduleView.Item[]>([])
  createEffect(() => {
    const sessionID = props.sessionID
    const refresh = () => setItems(ScheduleView.list(sessionID))
    refresh()
    const timer = setInterval(refresh, 2000)
    onCleanup(() => clearInterval(timer))
  })
  const label = () => `Триггеры: ${items().filter((item) => item.enabled).length}/${items().length} вкл. · открыть`
  return (
    <box flexShrink={0} minWidth={0}>
      <HoverAction onClick={() => dialog.replace(() => <DialogSchedules sessionID={props.sessionID} />)}>
        <text fg={theme.text.muted}>{scheduleEllipsis(label(), props.width ?? 32)}</text>
      </HoverAction>
    </box>
  )
}
