import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { scheduleDetails } from "../src/util/schedule-list"
const item = { id: "t", sessionID: "main", name: "Check fixture", kind: "interval" as const, enabled: true, nextAt: 60000, updatedAt: 1 }
test("sidebar schedule distinguishes active, paused and dispatch from verified result", () => {
  expect(scheduleDetails(item)).toContain("interval · active")
  expect(scheduleDetails(item)).toContain("Last result: not run")
  expect(scheduleDetails({ ...item, lastFiredAt: 100 })).toContain("Last result: dispatched (result unverified)")
  expect(scheduleDetails({ ...item, enabled: false, nextAt: null })).toContain("Next: none")
  expect(scheduleDetails(item, { triggerID: "t", browserSessionID: "b", enabled: true, nextAt: 60000, phase: "info" })).toContain("Last result: title/URL only")
  const source = readFileSync(new URL("../src/routes/session/sidebar.tsx", import.meta.url), "utf8")
  expect(source).toContain("<ScheduleList sessionID={props.sessionID}")
  expect(source.indexOf("<ScheduleList")).toBeLessThan(source.indexOf('<Slot path="sidebar.content"'))
})

test("browser watcher line never turns an event into a successful page read", () => {
  const browser = { ...item, kind: "browser" as const, nextAt: null }
  expect(scheduleDetails(browser)).toContain("Watcher: off")
  const status = { triggerID: "t", browserSessionID: "b", enabled: true, nextAt: null, phase: "waiting" as const, watcher: "watching" as const, lastEventAt: 100 }
  expect(scheduleDetails(browser, status)).toContain("Watcher: watching")
  expect(scheduleDetails(browser, status).some((line) => line.startsWith("Last event: "))).toBe(true)
  expect(scheduleDetails(browser, status).some((line) => line.startsWith("Last read: "))).toBe(false)
  expect(scheduleDetails({ ...browser, enabled: false }, status)).toContain("Watcher: off")
})
