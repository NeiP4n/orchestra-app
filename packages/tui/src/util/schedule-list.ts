import type { ScheduleView } from "@orchestra/core/schedule-view"
import type { BrowserSchedule } from "@orchestra/core/browser/schedule"
const clock = (at: number) => new Date(at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
const kinds = { interval: "интервал", cron: "по времени", once: "однократно", browser: "событие страницы" }
const phases = { waiting: "ожидание", dispatched: "отправлено, результат не проверен", checking: "чтение страницы", checked: "страница прочитана", info: "только заголовок и адрес", error: "ошибка, чтение не подтверждено", paused: "пауза" }

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
  return item.nextAt === null ? item.kind === "browser" && item.enabled ? "событие страницы" : "нет" : clock(item.nextAt)
}
export function scheduleSummary(item: ScheduleView.Item, width: number): string {
  const state = item.enabled ? "включено" : "пауза"
  const next = scheduleNext(item)
  const full = `${kinds[item.kind]} · ${state} · далее: ${next}`
  if (Array.from(full).length <= width) return full
  return scheduleEllipsis(`${state} · далее: ${next}`, width)
}
export function scheduleDetails(item: ScheduleView.Item, status?: BrowserSchedule.Status): string[] {
  const watcher = !item.enabled ? "выключен" : status?.watcher === "watching" ? "работает" : status?.watcher === "failed" ? "ошибка" : "выключен"
  return [
    `Тип: ${kinds[item.kind]} · ${item.enabled ? "включено" : "пауза"}`,
    ...(item.kind === "browser" ? [
      `Наблюдатель: ${watcher}`,
      `Последнее событие: ${status?.lastEventAt === undefined ? "не подтверждено" : clock(status.lastEventAt)}`,
    ] : []),
    `Следующий запуск: ${scheduleNext(item)}`,
    `Последний результат: ${status ? phases[status.phase] : item.lastFiredAt === undefined ? "ещё не запускалось" : phases.dispatched}`,
    ...(status?.lastCheckedAt === undefined ? [] : [`Последнее чтение: ${clock(status.lastCheckedAt)}`]),
    ...(item.pausedReason ? [`Причина паузы: ${schedulePause(item.pausedReason)}`] : []),
    `Код: ${item.id}`,
  ]
}
