import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { scheduleDetails, scheduleEllipsis, schedulePause, scheduleSummary, scheduleState, scheduleTone, scheduleWrap } from "../src/util/schedule-list"
const item = { id: "t", sessionID: "main", name: "Check fixture", kind: "interval" as const, enabled: true, nextAt: 60000, updatedAt: 1 }
test("sidebar schedule distinguishes active, paused and dispatch from verified result", () => {
  expect(scheduleState(item, undefined, 0)).toBe("через 1м")
  expect(scheduleDetails(item)).toContain("Последний результат: ещё не запускалось")
  expect(scheduleDetails({ ...item, lastFiredAt: 100 })).toContain("Последний результат: не проверен; отправлено")
  expect(scheduleDetails({ ...item, enabled: false, nextAt: null })).toContain("Следующий запуск: нет")
  expect(scheduleDetails(item, { triggerID: "t", browserSessionID: "b", enabled: true, nextAt: 60000, phase: "info" })).toContain("Последний результат: только заголовок и адрес")
  const source = readFileSync(new URL("../src/routes/session/sidebar.tsx", import.meta.url), "utf8")
  expect(source).toContain("<ScheduleList sessionID={props.sessionID}")
  expect(source.indexOf("<ScheduleList")).toBeLessThan(source.indexOf('<Slot path="sidebar.content"'))
})

test("browser watcher line never turns an event into a successful page read", () => {
  const browser = { ...item, kind: "browser" as const, nextAt: null }
  expect(scheduleDetails(browser)).toContain("выключен · последнее входящее: нет")
  const status = { triggerID: "t", browserSessionID: "b", enabled: true, nextAt: null, phase: "waiting" as const, watcher: "watching" as const, lastEventAt: 100 }
  expect(scheduleState(browser, status)).toBe("следит")
  expect(scheduleDetails(browser, status).some((line) => line.startsWith("следит · последнее входящее: "))).toBe(true)
  expect(scheduleDetails(browser, status).some((line) => line.startsWith("Последнее чтение: "))).toBe(false)
  expect(scheduleDetails({ ...browser, enabled: false }, status).some((line) => line.startsWith("выключен · последнее входящее:"))).toBe(true)
})


test("schedule rows adapt at word boundaries and translate pause caps", () => {
  expect(scheduleEllipsis("только прочитать страницу и отчитаться", 26)).toBe("только прочитать страницу…")
  expect(scheduleEllipsis("сверхдлинноесловобезпробелов", 8)).toBe("…")
  expect(schedulePause("paused: 6 firings in the last hour is this trigger's cap")).toBe("лимит 6 запусков в час")
  expect(schedulePause("paused: 48 firings in the last 24 hours is this trigger's cap")).toBe("лимит 48 запусков в сутки")
  expect(schedulePause("paused: the cron line has no next time")).toBe("нет следующего запуска по расписанию")
  expect(scheduleSummary({ ...item, enabled: false, nextAt: null }, 24)).toBe("выкл.")
  for (const width of [1, 12, 24, 48]) {
    for (const line of scheduleDetails({ ...item, lastFiredAt: 100 }).flatMap((line) => scheduleWrap(line, width))) {
      expect(Array.from(line).length).toBeLessThanOrEqual(width)
    }
    expect(Array.from(scheduleSummary(item, width)).length).toBeLessThanOrEqual(width)
  }
})

test("sidebar is one quiet line opening a separate trigger window, not inline controls", () => {
  const source = readFileSync(new URL("../src/component/schedule-list.tsx", import.meta.url), "utf8")
  expect(source).toContain("Триггеры:")
  expect(source).toContain("<DialogSchedules sessionID={props.sessionID}")
  expect(source).not.toContain("requestRemoval")
  expect(source).not.toContain("scheduleDetails")
  expect(source).not.toContain("Trigger.pause")
  expect(source).not.toContain("Trigger.resume")
})


test("one-line status and at most three details do not repeat type or expose opaque IDs", () => {
  const paused = { ...item, enabled: false, nextAt: null, pausedReason: "paused: 6 firings in the last hour is this trigger's cap", lastFiredAt: 100 }
  expect(scheduleState(paused)).toBe("пауза: лимит")
  expect(scheduleTone(paused)).toBe("yellow")
  expect(scheduleState({ ...item, nextAt: 3 * 3600000 }, undefined, 0)).toBe("через 3ч")
  const lines = scheduleDetails(paused)
  expect(lines.length).toBeLessThanOrEqual(3)
  expect(lines.some((line) => line.startsWith("Тип:") || line.startsWith("Код:"))).toBe(false)
  expect(lines).toContain("Причина паузы: лимит 6 запусков в час")
  expect(lines).toContain("Последний результат: не проверен; отправлено")
  const source = readFileSync(new URL("../src/component/schedule-list.tsx", import.meta.url), "utf8")
  expect(source).toContain("<DialogSchedules")
  expect(source).not.toContain("TextAttributes.BOLD")
  expect(source).not.toContain("scheduleWrap(")
})
