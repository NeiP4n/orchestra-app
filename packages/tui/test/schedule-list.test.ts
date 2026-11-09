import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { scheduleDetails, scheduleEllipsis, schedulePause, scheduleSummary, scheduleWrap } from "../src/util/schedule-list"
const item = { id: "t", sessionID: "main", name: "Check fixture", kind: "interval" as const, enabled: true, nextAt: 60000, updatedAt: 1 }
test("sidebar schedule distinguishes active, paused and dispatch from verified result", () => {
  expect(scheduleDetails(item)).toContain("Тип: интервал · включено")
  expect(scheduleDetails(item)).toContain("Последний результат: ещё не запускалось")
  expect(scheduleDetails({ ...item, lastFiredAt: 100 })).toContain("Последний результат: отправлено, результат не проверен")
  expect(scheduleDetails({ ...item, enabled: false, nextAt: null })).toContain("Следующий запуск: нет")
  expect(scheduleDetails(item, { triggerID: "t", browserSessionID: "b", enabled: true, nextAt: 60000, phase: "info" })).toContain("Последний результат: только заголовок и адрес")
  const source = readFileSync(new URL("../src/routes/session/sidebar.tsx", import.meta.url), "utf8")
  expect(source).toContain("<ScheduleList sessionID={props.sessionID}")
  expect(source.indexOf("<ScheduleList")).toBeLessThan(source.indexOf('<Slot path="sidebar.content"'))
})

test("browser watcher line never turns an event into a successful page read", () => {
  const browser = { ...item, kind: "browser" as const, nextAt: null }
  expect(scheduleDetails(browser)).toContain("Наблюдатель: выключен")
  const status = { triggerID: "t", browserSessionID: "b", enabled: true, nextAt: null, phase: "waiting" as const, watcher: "watching" as const, lastEventAt: 100 }
  expect(scheduleDetails(browser, status)).toContain("Наблюдатель: работает")
  expect(scheduleDetails(browser, status).some((line) => line.startsWith("Последнее событие: "))).toBe(true)
  expect(scheduleDetails(browser, status).some((line) => line.startsWith("Последнее чтение: "))).toBe(false)
  expect(scheduleDetails({ ...browser, enabled: false }, status)).toContain("Наблюдатель: выключен")
})


test("schedule rows adapt at word boundaries and translate pause caps", () => {
  expect(scheduleEllipsis("только прочитать страницу и отчитаться", 26)).toBe("только прочитать страницу…")
  expect(scheduleEllipsis("сверхдлинноесловобезпробелов", 8)).toBe("…")
  expect(schedulePause("paused: 6 firings in the last hour is this trigger's cap")).toBe("лимит 6 запусков в час")
  expect(schedulePause("paused: 48 firings in the last 24 hours is this trigger's cap")).toBe("лимит 48 запусков в сутки")
  expect(schedulePause("paused: the cron line has no next time")).toBe("нет следующего запуска по расписанию")
  expect(scheduleSummary({ ...item, enabled: false, nextAt: null }, 24)).toBe("пауза · далее: нет")
  for (const width of [1, 12, 24, 48]) {
    for (const line of scheduleDetails({ ...item, lastFiredAt: 100 }).flatMap((line) => scheduleWrap(line, width))) {
      expect(Array.from(line).length).toBeLessThanOrEqual(width)
    }
    expect(Array.from(scheduleSummary(item, width)).length).toBeLessThanOrEqual(width)
  }
})

test("schedule section and rows collapse independently without changing schedule state", () => {
  const source = readFileSync(new URL("../src/component/schedule-list.tsx", import.meta.url), "utf8")
  expect(source).toContain("Расписания")
  expect(source).toContain("setCollapsed((value) => !value)")
  expect(source).toContain("[item.id]: !value[item.id]")
  expect(source).toContain("when={expanded()[item.id]}")
  expect(source).toContain("onSizeChange")
  expect(source).not.toContain("Trigger.pause")
  expect(source).not.toContain("Trigger.resume")
})
