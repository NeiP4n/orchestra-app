import { expect, test } from "bun:test"
import { BrowserSchedule } from "@orchestra/core/browser/schedule"

// No Chrome, page text or real profiles: the test launcher supplies a temporary data root.
test("browser schedule status records successful reads, not dispatches", () => {
  const id = `test_schedule_${process.pid}`
  const trigger = { id, browserSessionID: "browser_fixture", enabled: true, nextAt: 60_000 }
  try {
    BrowserSchedule.sync(trigger)
    expect(BrowserSchedule.get(id)?.phase).toBe("waiting")
    BrowserSchedule.dispatched(id, 1000)
    expect(BrowserSchedule.get(id)).toMatchObject({ phase: "dispatched", lastDispatchAt: 1000 })
    expect(BrowserSchedule.get(id)?.lastCheckedAt).toBeUndefined()
    BrowserSchedule.finished(id, "another_browser", true, 2000)
    expect(BrowserSchedule.get(id)?.lastCheckedAt).toBeUndefined()
    BrowserSchedule.started(id, "browser_fixture")
    expect(BrowserSchedule.get(id)?.phase).toBe("checking")
    BrowserSchedule.finished(id, "browser_fixture", false, 2000)
    expect(BrowserSchedule.get(id)?.phase).toBe("error")
    expect(BrowserSchedule.get(id)?.lastCheckedAt).toBeUndefined()
    BrowserSchedule.finished(id, "browser_fixture", true, 3000)
    expect(BrowserSchedule.get(id)).toMatchObject({ phase: "checked", lastCheckedAt: 3000 })
    BrowserSchedule.sync({ ...trigger, enabled: false })
    BrowserSchedule.finished(id, "browser_fixture", true, 4000)
    expect(BrowserSchedule.get(id)).toMatchObject({ phase: "paused", lastCheckedAt: 3000, nextAt: null })
    BrowserSchedule.sync(trigger)
    expect(BrowserSchedule.get(id)?.phase).toBe("waiting")
    BrowserSchedule.deliveryFailed(id)
    expect(BrowserSchedule.get(id)?.phase).toBe("error")
  } finally { BrowserSchedule.remove(id) }
  expect(BrowserSchedule.get(id)).toBeUndefined()
})
