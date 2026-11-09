import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Trigger } from "@orchestra/core/trigger"
import { ScheduleView } from "@orchestra/core/schedule-view"
test("schedule sidebar projection is read-only, scoped and shows paused records", () => {
  const previous = process.env.ORCHESTRA_DATA_DIR
  const root = mkdtempSync(path.join(os.tmpdir(), "schedule-view-"))
  process.env.ORCHESTRA_DATA_DIR = root
  try {
    const made = Trigger.create({ kind: "interval", spec: "60", prompt: "Check fixture" }, { id: "t", projectID: "p", now: 1000, existing: 0 })
    if (!made.ok) throw new Error(made.error)
    expect(ScheduleView.sync(made.trigger, "main")).toBe(true)
    expect(ScheduleView.list("other")).toEqual([])
    expect(ScheduleView.list("main")[0]).toMatchObject({ name: "Check fixture", kind: "interval", enabled: true, nextAt: 3601000 })
    ScheduleView.sync({ ...made.trigger, enabled: false, pausedReason: "operator pause" }, "main")
    expect(ScheduleView.list("main")[0]).toMatchObject({ enabled: false, pausedReason: "operator pause" })
    expect(made.trigger.enabled).toBe(true)
    expect(ScheduleView.remove("t")).toBe(true)
    expect(ScheduleView.list("main")).toEqual([])
  } finally {
    if (previous === undefined) delete process.env.ORCHESTRA_DATA_DIR
    else process.env.ORCHESTRA_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})
