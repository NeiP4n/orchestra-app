import { expect, test } from "bun:test"
import { scheduleLine } from "../src/util/browser-schedule"

const base = { triggerID: "t", browserSessionID: "b", enabled: true, nextAt: 10_000, phase: "waiting" as const }
test("schedule indicator distinguishes dispatch from a fresh page read", () => {
  expect(scheduleLine({ ...base, phase: "dispatched", lastDispatchAt: 100 }, 200)).toContain("awaiting BrowserAgent")
  expect(scheduleLine({ ...base, phase: "dispatched", lastDispatchAt: 100 }, 200)).toContain("last read: never")
  expect(scheduleLine({ ...base, phase: "checked", lastCheckedAt: 100 }, 200)).toContain("page read completed")
  expect(scheduleLine({ ...base, phase: "checking" }, 200)).toContain("reading page")
  expect(scheduleLine({ ...base, phase: "error" }, 200)).toContain("last read: never")
  expect(scheduleLine({ ...base, enabled: false, phase: "paused" }, 200)).toContain("next: none")
  expect(scheduleLine({ ...base, enabled: false, phase: "error" }, 200)).toContain(": error |")
  expect(scheduleLine(base, 10_001)).toContain("next: due")
})
