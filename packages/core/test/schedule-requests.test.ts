import { test, expect } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ScheduleRequests } from "@orchestra/core/schedule-requests"
import { ScheduleView } from "@orchestra/core/schedule-view"
import { Trigger } from "@orchestra/core/trigger"
test("operator commands are exact-main scoped, latest-request acknowledged, without claiming execution at save", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "schedule-command-")),
    previous = process.env.ORCHESTRA_DATA_DIR
  process.env.ORCHESTRA_DATA_DIR = root
  try {
    const made = Trigger.create(
      { kind: "interval", spec: "60", prompt: "Report status" },
      { id: "trg_request", projectID: "p", now: 1000, existing: 0 },
    )
    if (!made.ok) throw Error(made.error)
    ScheduleView.sync(made.trigger, "main")
    expect(() => ScheduleRequests.request(made.trigger.id, "foreign", "pause")).toThrow()
    const first = ScheduleRequests.request(made.trigger.id, "main", "pause")
    expect(ScheduleRequests.read(made.trigger.id, "foreign")).toBeUndefined()
    expect(ScheduleRequests.result(first)).toBeUndefined()
    expect(ScheduleView.list("main")[0]?.enabled).toBe(true)
    const next = ScheduleRequests.request(made.trigger.id, "main", "resume")
    ScheduleRequests.finish(first, true, "old pause finished")
    expect(ScheduleRequests.read(made.trigger.id, "main")).toEqual(next)
    expect(ScheduleRequests.result(next)).toBeUndefined()
    ScheduleRequests.finish(next, false, "browser unavailable")
    expect(ScheduleRequests.result(next)).toMatchObject({ ok: false, message: "browser unavailable" })
    expect(ScheduleRequests.read(made.trigger.id, "main")).toBeUndefined()
    writeFileSync(
      path.join(root, "schedule-requests", `${made.trigger.id}.command.json`),
      JSON.stringify({ ...next, action: "shell" }),
    )
    expect(ScheduleRequests.read(made.trigger.id, "main")).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.ORCHESTRA_DATA_DIR
    else process.env.ORCHESTRA_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})
