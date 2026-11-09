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
