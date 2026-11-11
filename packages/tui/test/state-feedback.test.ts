import { expect, test } from "bun:test"
import { feedbackEntries, feedbackFrame } from "../src/ui/state-feedback"
import { readFileSync } from "node:fs"
test("initial mount does not fake activation; real state change flashes once then settles", () => {
  const first = feedbackEntries([], [{ id: "a", phase: "idle" }], 0)
  expect(feedbackFrame(first[0], 0, true).flash).toBe(false)
  const activated = feedbackEntries(first, [{ id: "a", phase: "working" }], 100)
  expect(feedbackFrame(activated[0], 200, true).flash).toBe(true)
  expect(feedbackFrame(activated[0], 900, true).flash).toBe(false)
  expect(feedbackEntries(activated, [{ id: "a", phase: "working" }], 300)[0]?.activatedAt).toBe(100)
})
test("waiting pulses only with motion; errors and paused never move", () => {
  const waiting = { id: "a", phase: "waiting" as const, activatedAt: 0 }
  expect(feedbackFrame(waiting, 300, true).pulse).toBeGreaterThan(0)
  expect(feedbackFrame(waiting, 300, false)).toEqual({ phase: "waiting", pulse: 0, flash: false })
  for (const phase of ["error", "paused"] as const) expect(feedbackFrame({ ...waiting, phase }, 300, true)).toEqual({ phase, pulse: 0, flash: false })
})
test("watcher/trigger token changes flash without fake success and list memory is bounded", () => {
  const before = feedbackEntries([], [{ id: "t", phase: "working", token: "off:1" }], 0)
  const after = feedbackEntries(before, [{ id: "t", phase: "working", token: "watching:2" }], 100)
  expect(feedbackFrame(after[0], 200, true).flash).toBe(true)
  expect(feedbackEntries([], Array.from({ length: 1000 }, (_, id) => ({ id: String(id), phase: "idle" })), 0)).toHaveLength(256)
  const module = readFileSync(new URL("../src/ui/state-feedback.ts", import.meta.url), "utf8")
  expect(module).toContain("setTimeout(() => setNow(Date.now()), 250)")
  expect(module).toContain("if (!motion()")
  expect(module).not.toContain("setInterval")
})
