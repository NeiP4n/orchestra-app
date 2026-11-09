import { ScheduleLimitDialog } from "./schedule-limit-dialog"
import { useDialog } from "../ui/dialog"
import { hoverBackground } from "../ui/hover"
import { Keymap } from "../context/keymap"
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
  const dialog = useDialog()
  const editLimit=(item:ScheduleView.Item,day=false)=>dialog.replace(()=><ScheduleLimitDialog item={item} sessionID={props.sessionID} day={day} onSaved={()=>{setNow(Date.now());setError("")}}/>)

  const [hoveredRemove, setHoveredRemove] = createSignal<string>()
  const [selected, setSelected] = createSignal<string>()
  const [armed, setArmed] = createSignal<string>()
  const [error, setError] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const remove = (id: string) => {
    setSelected(id)
    if (armed() !== id) { setArmed(id); return }
    try { ScheduleView.requestRemoval(id, props.sessionID); setArmed(); setError("") } catch { setError("Не удалось удалить расписание.") }
  }
  const [collapsed, setCollapsed] = createSignal(true)
  Keymap.createLayer(() => ({ enabled: () => !collapsed() && !!selected(), commands: [{ bind: "ctrl+d", title: "Удалить выбранное расписание (дважды)", group: "Расписания", run: () => { const id = selected(); if (id) remove(id) } }] }))
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
    const refresh = () => { setNow(Date.now()); setItems(ScheduleView.list(sessionID).map((item) => ({ item, status: BrowserSchedule.get(item.id) }))) }
    refresh()
    // Local read-only projection only; never polls a page or fires a schedule.
    const timer = setInterval(refresh, 2000)
    onCleanup(() => clearInterval(timer))
  })
  return <box flexDirection="column" flexShrink={0} minWidth={0} onSizeChange={function () { setMeasuredWidth(this.width) }}>
    <HoverAction onClick={() => setCollapsed((value) => !value)}>
      <text fg={theme.text.base}>{scheduleEllipsis(`${collapsed() ? "▸" : "▾"} Расписания (${items().length})`, width())}</text>
    </HoverAction>
    <Show when={error()}><text fg={theme.text.feedback.error.base}>{error()}</text></Show>
    <Show when={!collapsed()}>
      <Show when={items().length > 0} fallback={<text fg={theme.text.muted}>{scheduleEllipsis("Нет расписаний для этого чата", width())}</text>}>
        <For each={items()}>{({ item, status }) => <box flexDirection="column" flexShrink={0} minWidth={0}>
          <HoverAction onClick={() => { setSelected(item.id); setExpanded((value) => ({ ...value, [item.id]: !value[item.id] })) }}>
            <box flexDirection="row" width="100%" minWidth={0} gap={1}>
              <text fg={feedback(item.id).flash ? theme.text.action.primary.base : scheduleTone(item, status) === "green" ? theme.text.feedback.success.base : scheduleTone(item, status) === "yellow" ? theme.text.feedback.warning.base : theme.text.muted}>●</text>
              <box flexGrow={1} minWidth={0}>
                <text fg={theme.text.base}>{scheduleEllipsis(item.name || "Без названия", Math.max(1, width() - Math.min(14, Array.from(scheduleState(item, status)).length) - 8))}</text>
              </box>
              <text fg={theme.text.muted} attributes={TextAttributes.DIM}>{scheduleEllipsis(scheduleState(item, status), Math.max(1, Math.min(14, width() - 5)))}</text>
            </box>
          </HoverAction>
          <box flexDirection="row" gap={1}>
            <box flexGrow={1}><text fg={theme.text.muted}>{item.lastFiredAt === undefined ? "ещё не срабатывал" : `сработал ${Math.max(0, Math.floor((now() - item.lastFiredAt) / 1000))} с назад · ${item.total ?? "?"} раз`}</text></box>
            <box minWidth={5} backgroundColor={hoveredRemove() === item.id ? hoverBackground(theme, "destructive") : undefined} onMouseOver={() => setHoveredRemove(item.id)} onMouseOut={() => setHoveredRemove(undefined)} onMouseDown={(event) => event.stopPropagation()} onMouseUp={(event) => { event.stopPropagation(); remove(item.id) }}>
              <text fg={theme.text.feedback.error.base}>{ScheduleView.removalRequested(item.id, props.sessionID) ? "удаление…" : armed() === item.id ? "[да?]" : "[ × ]"}</text>
            </box>
          </box>
          <HoverAction onClick={() => editLimit(item)}><text fg={item.maxPerHour === null ? theme.text.feedback.warning.base : theme.text.muted}>{`Час: ${(item.fired ?? []).filter((at) => at > now()-3600_000).length}/${item.maxPerHour === null ? "без лимита · расширено" : item.maxPerHour ?? 6} · изменить`}</text></HoverAction>
          <Show when={ScheduleView.hourlyLimitRequested(item.id,props.sessionID)}>{request=><text fg={theme.text.muted}>{`Час: запрос ${request().maxPerHour??"без лимита"} сохранён; ждёт сервиса`}</text>}</Show>
          <HoverAction onClick={()=>editLimit(item,true)}><text fg={theme.text.muted}>{`Сутки: ${(item.fired??[]).filter(at=>at>now()-86400_000).length}/${item.maxPerDay??48} · изменить`}</text></HoverAction>
          <Show when={ScheduleView.dailyLimitRequested(item.id,props.sessionID)}>{request=><text fg={theme.text.muted}>{`Сутки: запрос ${request().maxPerDay} сохранён; ждёт сервиса`}</text>}</Show>
          <Show when={expanded()[item.id]}>
            <For each={scheduleDetails(item, status).map((line) => scheduleEllipsis(line, width()))}>{(line) => <text fg={theme.text.muted} attributes={TextAttributes.DIM}>{line}</text>}</For>
          </Show>
        </box>}</For>
      </Show>
    </Show>
  </box>
}
