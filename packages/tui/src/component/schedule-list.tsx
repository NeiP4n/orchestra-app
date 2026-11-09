import { createStateFeedback } from "../ui/state-feedback"
import { useConfig } from "../config"
import { useMotion } from "./neural"
import { TextAttributes } from "@opentui/core"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { ScheduleView } from "@orchestra/core/schedule-view"
import { BrowserSchedule } from "@orchestra/core/browser/schedule"
import { useTheme } from "../context/theme"
import { HoverAction } from "./hover-action"
import { scheduleDetails, scheduleEllipsis, scheduleState, scheduleTone } from "../util/schedule-list"

export function ScheduleList(props: { sessionID: string; width?: number }) {
  const theme = useTheme()
  const [collapsed, setCollapsed] = createSignal(true)
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const [measuredWidth, setMeasuredWidth] = createSignal<number>()
  const width = () => Math.max(1, measuredWidth() ?? props.width ?? 32)
  const [items, setItems] = createSignal<Array<{ item: ScheduleView.Item; status?: BrowserSchedule.Status }>>([])
  const motion = useMotion()
  const config = useConfig().data
  const feedback = createStateFeedback(
    () => items().map(({ item, status }) => ({ id: item.id, phase: !item.enabled ? "paused" as const : status?.phase === "error" || status?.watcher === "failed" ? "error" as const : "working" as const, token: `${status?.watcher ?? "off"}:${item.lastFiredAt ?? ""}` })),
    () => !collapsed() && motion() && (config.stateEffects ?? true),
  )
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
          <HoverAction onClick={() => setExpanded((value) => ({ ...value, [item.id]: !value[item.id] }))}>
            <box flexDirection="row" width="100%" minWidth={0} gap={1}>
              <text fg={feedback(item.id).flash ? theme.text.action.primary.base : scheduleTone(item, status) === "green" ? theme.text.feedback.success.base : scheduleTone(item, status) === "yellow" ? theme.text.feedback.warning.base : theme.text.muted}>●</text>
              <box flexGrow={1} minWidth={0}>
                <text fg={theme.text.base}>{scheduleEllipsis(item.name || "Без названия", Math.max(1, width() - Math.min(14, Array.from(scheduleState(item, status)).length) - 3))}</text>
              </box>
              <text fg={theme.text.muted} attributes={TextAttributes.DIM}>{scheduleEllipsis(scheduleState(item, status), Math.max(1, Math.min(14, width() - 5)))}</text>
            </box>
          </HoverAction>
          <Show when={expanded()[item.id]}>
            <For each={scheduleDetails(item, status).map((line) => scheduleEllipsis(line, width()))}>{(line) => <text fg={theme.text.muted} attributes={TextAttributes.DIM}>{line}</text>}</For>
          </Show>
        </box>}</For>
      </Show>
    </Show>
  </box>
}
