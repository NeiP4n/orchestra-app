import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { ScheduleView } from "@orchestra/core/schedule-view"
import { BrowserSchedule } from "@orchestra/core/browser/schedule"
import { useTheme } from "../context/theme"
import { scheduleDetails } from "../util/schedule-list"

export function ScheduleList(props: { sessionID: string }) {
  const theme = useTheme()
  const [items, setItems] = createSignal<Array<{ item: ScheduleView.Item; status?: BrowserSchedule.Status }>>([])
  createEffect(() => {
    const sessionID = props.sessionID
    const refresh = () => setItems(ScheduleView.list(sessionID).map((item) => ({ item, status: BrowserSchedule.get(item.id) })))
    refresh()
    // Local read-only projection only; never polls a page or fires a schedule.
    const timer = setInterval(refresh, 2000)
    onCleanup(() => clearInterval(timer))
  })
  return <box flexDirection="column" flexShrink={0} gap={1}>
    <text fg={theme.text.base}>Schedules ({items().length})</text>
    <Show when={items().length > 0} fallback={<text fg={theme.text.muted}>No local schedule records for this chat</text>}>
      <For each={items()}>{({ item, status }) => <box flexDirection="column" flexShrink={0}>
        <text fg={theme.text.base} wrapMode="word">{item.name || item.id}</text>
        <text fg={theme.text.muted} wrapMode="word">{item.id}</text>
        <For each={scheduleDetails(item, status)}>{(line) => <text fg={status?.phase === "error" ? theme.text.feedback.error.base : theme.text.muted} wrapMode="word">{line}</text>}</For>
      </box>}</For>
    </Show>
  </box>
}
