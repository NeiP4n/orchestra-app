import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { ScheduleView } from "@orchestra/core/schedule-view"
import { BrowserSchedule } from "@orchestra/core/browser/schedule"
import { useTheme } from "../context/theme"
import { HoverAction } from "./hover-action"
import { scheduleDetails, scheduleEllipsis, scheduleSummary, scheduleWrap } from "../util/schedule-list"

export function ScheduleList(props: { sessionID: string; width?: number }) {
  const theme = useTheme()
  const [collapsed, setCollapsed] = createSignal(false)
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const [measuredWidth, setMeasuredWidth] = createSignal<number>()
  const width = () => Math.max(1, measuredWidth() ?? props.width ?? 32)
  const [items, setItems] = createSignal<Array<{ item: ScheduleView.Item; status?: BrowserSchedule.Status }>>([])
  createEffect(() => {
    const sessionID = props.sessionID
    setExpanded({})
    const refresh = () => setItems(ScheduleView.list(sessionID).map((item) => ({ item, status: BrowserSchedule.get(item.id) })))
    refresh()
    // Local read-only projection only; never polls a page or fires a schedule.
    const timer = setInterval(refresh, 2000)
    onCleanup(() => clearInterval(timer))
  })
  return <box flexDirection="column" flexShrink={0} minWidth={0} onSizeChange={function () { setMeasuredWidth(this.width) }}>
    <HoverAction onClick={() => setCollapsed((value) => !value)}>
      <text fg={theme.text.base}>{scheduleEllipsis(`${collapsed() ? "▸" : "▾"} Расписания (${items().length})`, width())}</text>
    </HoverAction>
    <Show when={!collapsed()}>
      <Show when={items().length > 0} fallback={<text fg={theme.text.muted}>{scheduleEllipsis("Нет расписаний для этого чата", width())}</text>}>
        <For each={items()}>{({ item, status }) => <box flexDirection="column" flexShrink={0} minWidth={0}>
          <HoverAction flexDirection="column" onClick={() => setExpanded((value) => ({ ...value, [item.id]: !value[item.id] }))}>
            <text fg={theme.text.base}>{`${expanded()[item.id] ? "▾" : "▸"} ${scheduleEllipsis(item.name || "Без названия", Math.max(1, width() - 2))}`}</text>
            <text fg={theme.text.muted}>{scheduleSummary(item, width())}</text>
          </HoverAction>
          <Show when={expanded()[item.id]}>
            <For each={scheduleDetails(item, status).flatMap((line) => scheduleWrap(line, width()))}>{(line) => <text fg={status?.phase === "error" ? theme.text.feedback.error.base : theme.text.muted}>{line}</text>}</For>
          </Show>
        </box>}</For>
      </Show>
    </Show>
  </box>
}
