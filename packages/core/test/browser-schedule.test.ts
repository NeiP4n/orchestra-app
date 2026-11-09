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
    BrowserSchedule.inspected(id, "browser_fixture", 1500)
    expect(BrowserSchedule.get(id)).toMatchObject({ phase: "info", lastInfoAt: 1500 })
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

test("denied status IO degrades to an error without a defect or a fake success", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const previous = process.env.ORCHESTRA_DATA_DIR
  const root = mkdtempSync(path.join(os.tmpdir(), "schedule-denied-"))
  process.env.ORCHESTRA_DATA_DIR = root
  const trigger = { id: "denied", browserSessionID: "b", enabled: true, nextAt: 100 }
  try {
    // A regular file where a directory is required deterministically refuses
    // writes even under privileged CI users, unlike chmod-based fixtures.
    writeFileSync(path.join(root, "browser-schedules"), "blocked")
    expect(() => BrowserSchedule.sync(trigger)).not.toThrow()
    expect(BrowserSchedule.get("denied")).toMatchObject({ phase: "error", enabled: false })
    expect(() => BrowserSchedule.finished("denied", "b", true, 500)).not.toThrow()
    expect(BrowserSchedule.get("denied")?.lastCheckedAt).toBeUndefined()
    expect(BrowserSchedule.forSession("b")).toHaveLength(1)
    expect(BrowserSchedule.remove("denied")).toBe(false)
    rmSync(path.join(root, "browser-schedules"))
    BrowserSchedule.sync(trigger)
    expect(BrowserSchedule.get("denied")?.enabled).toBe(true)
    BrowserSchedule.finished("denied", "b", true, 600)
    expect(BrowserSchedule.get("denied")?.lastCheckedAt).toBe(600)
    BrowserSchedule.remove("denied")
  } finally {
    if (previous === undefined) delete process.env.ORCHESTRA_DATA_DIR
    else process.env.ORCHESTRA_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test("watcher status distinguishes installation, accepted events and off", () => {
  const id = `watch_status_${process.pid}`
  try {
    BrowserSchedule.sync({ id, browserSessionID: "watched", enabled: true, nextAt: null })
    BrowserSchedule.watchStatus(id, false)
    expect(BrowserSchedule.get(id)?.watcher).toBe("failed")
    BrowserSchedule.watchStatus(id, true)
    expect(BrowserSchedule.get(id)?.watcher).toBe("watching")
    expect(BrowserSchedule.get(id)?.lastEventAt).toBeUndefined()
    BrowserSchedule.watchStatus(id, true, 1234)
    expect(BrowserSchedule.get(id)?.lastEventAt).toBe(1234)
    expect(BrowserSchedule.get(id)?.lastCheckedAt).toBeUndefined()
    BrowserSchedule.sync({ id, browserSessionID: "watched", enabled: false, nextAt: null })
    BrowserSchedule.watchStatus(id, false)
    expect(BrowserSchedule.get(id)?.watcher).toBe("off")
  } finally { BrowserSchedule.remove(id) }
})
