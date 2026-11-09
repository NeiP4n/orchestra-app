import type { ScheduleView } from "@orchestra/core/schedule-view"
import type { BrowserSchedule } from "@orchestra/core/browser/schedule"
const clock = (at: number) => new Date(at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
const phases = { waiting: "ожидание", dispatched: "не проверен; отправлено", checking: "чтение страницы", checked: "страница прочитана", info: "только заголовок и адрес", error: "ошибка, чтение не подтверждено", paused: "пауза" }

/** Elide whole words, never leave a prompt cut in the middle of a word. */
export function scheduleEllipsis(value: string, width: number): string {
  const text = value.replace(/\s+/g, " ").trim()
  const size = Math.max(1, Math.floor(width))
  if (Array.from(text).length <= size) return text
  const prefix = Array.from(text).slice(0, size - 1).join("")
  if (/\s/.test(Array.from(text)[size - 1] ?? "")) return `${prefix.trimEnd()}…`
  const boundary = prefix.lastIndexOf(" ")
  return boundary > 0 ? `${prefix.slice(0, boundary)}…` : "…"
}

/** Expanded details wrap at words too. Long opaque IDs/tokens are elided, not split. */
export function scheduleWrap(text: string, width: number): string[] {
  const size = Math.max(1, Math.floor(width))
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = scheduleEllipsis(word, size)
    if (line && Array.from(`${line} ${next}`).length > size) { lines.push(line); line = "" }
    line = line ? `${line} ${next}` : next
  }
  if (line) lines.push(line)
  return lines
}
export function schedulePause(reason: string): string {
  const cap = reason.match(/paused: (\d+) firings in the last (hour|24 hours)/)
  if (cap) return `лимит ${cap[1]} запусков ${cap[2] === "hour" ? "в час" : "в сутки"}`
  if (reason.includes("cron line has no next time")) return "нет следующего запуска по расписанию"
  if (!/[a-z]/i.test(reason)) return reason
  return "расписание приостановлено; требуется проверка причины"
}
export function scheduleNext(item: ScheduleView.Item): string {
  return item.nextAt === null ? item.enabled && item.kind === "internal" ? "событие Orchestra" : item.kind === "browser" && item.enabled ? "событие страницы" : "нет" : clock(item.nextAt)
}
export function scheduleState(item: ScheduleView.Item, status?: BrowserSchedule.Status, now = Date.now()): string {
  if (item.pendingDelivery) return "доставка ожидается"
  if (!item.enabled) return item.pausedReason ? /firings.*cap/.test(item.pausedReason) ? "пауза: лимит" : "пауза" : "выкл."
  if (item.kind === "browser" && status?.watcherReason) return "ждёт браузер"
  if (status?.phase === "error" || status?.watcher === "failed") return "ошибка"
  if (item.actionErrors) return "ошибка действия"
  if (item.kind === "internal") return "ждёт событие"
  if (item.kind === "browser") return status?.watcher === "watching" ? "следит" : "выкл."
  if (item.nextAt === null) return "выкл."
  const minutes = Math.max(0, Math.ceil((item.nextAt - now) / 60000))
  return minutes === 0 ? "скоро" : minutes >= 60 ? `через ${Math.ceil(minutes / 60)}ч` : `через ${minutes}м`
}
export function scheduleTone(item: ScheduleView.Item, status?: BrowserSchedule.Status): "green" | "yellow" | "grey" {
  if (!item.enabled) return item.pausedReason ? "yellow" : "grey"
  if (status?.phase === "error" || status?.watcher === "failed") return "yellow"
  return item.kind === "browser" ? status?.watcher === "watching" ? "green" : "grey" : "green"
}
export function scheduleSummary(item: ScheduleView.Item, width: number): string {
  return scheduleEllipsis(scheduleState(item), width)
}
export function scheduleDetails(item: ScheduleView.Item, status?: BrowserSchedule.Status): string[] {
  const result = item.localActions ? item.actionErrors ? "ошибка действия; см. журнал" : item.lastFiredAt === undefined ? "ещё не запускалось" : "локальное действие; см. журнал" : status ? phases[status.phase] : item.lastFiredAt === undefined ? "ещё не запускалось" : phases.dispatched
  const watcher = !item.enabled ? "выключен" : status?.watcher === "watching" ? "следит" : status?.watcher === "failed" ? "ошибка наблюдателя" : "выключен"
  return [
    item.kind === "browser"
      ? `${watcher} · последнее входящее: ${status?.lastEventAt === undefined ? "нет" : clock(status.lastEventAt)}`
      : `Следующий запуск: ${scheduleNext(item)}`,
    `Последний результат: ${result}${status?.lastCheckedAt === undefined ? "" : ` · чтение ${clock(status.lastCheckedAt)}`}`,
    ...(status?.watcherReason ? [status.watcherReason] : []),
    ...(item.missedCount ? [`Пропущено: ${item.missedCountAtLeast ? "не менее " : ""}${item.missedCount}${item.lastMissedAt ? ` · ${clock(item.lastMissedAt)}` : ""}`] : []),
    ...(status?.lostPendingRows ? [`Потеряно при перезапуске: ${status.lostPendingRows} строк; повтор не выполнен`] : []),
    ...(status?.restartedAt ? ["Наблюдение восстановлено после перезапуска; события во время простоя неизвестны"] : []),
    ...(status?.pendingRows ? [`В очереди наблюдателя: ${status.pendingRows}`] : []),
    ...(item.pausedReason ? [`Причина паузы: ${schedulePause(item.pausedReason)}`] : []),
  ]
}
