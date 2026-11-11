import { expect, test } from "bun:test"
import { Trigger } from "../src/trigger"
import { TriggerReview } from "../src/trigger-review"

test("review covers instruction, source, account binding, actions and limits but never resets runtime history", () => {
  const made = Trigger.create(
    { kind: "interval", spec: "60", prompt: "Read status" },
    { id: "trg_review", projectID: "project", now: 1000, existing: 0 },
  )
  if (!made.ok) throw Error(made.error)
  const paused = { ...made.trigger, enabled: false, nextAt: null, publishApproved: false, fired: [1000], total: 1 }
  const digest = TriggerReview.snapshot(paused).digest
  expect(TriggerReview.matches(paused, digest)).toBe(true)
  for (const patch of [
    { prompt: "Different" },
    { spec: "30" },
    { projectID: "foreign" },
    { browserSessionID: "new_browser" },
    { maxPerHour: 2 },
    { maxPerDay: 3 },
    { publishApproved: true },
    { missedPolicy: "run-once" as const },
    { condition: { type: "time" as const, kind: "interval" as const, spec: "120" } },
  ])
    expect(TriggerReview.matches({ ...paused, ...patch }, digest)).toBe(false)
  expect(TriggerReview.matches({ ...paused, total: 2, fired: [1000, 2000] }, digest)).toBe(true)
  const resumed = Trigger.resume(paused, 2000)!
  expect(resumed.enabled).toBe(true)
  expect(resumed.publishApproved).toBe(false)
  expect(resumed.fired).toEqual([1000])
  expect(resumed.total).toBe(1)
  expect(TriggerReview.matches(resumed, digest)).toBe(false)
})
