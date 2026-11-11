import { expect, test } from "bun:test"
import { TriggerActions } from "@orchestra/core/trigger-actions"
import { Trigger } from "@orchestra/core/trigger"
test("closed allowlist rejects executable code and self-authorized privileges", () => {
  for (const kind of ["browser.js", "browser.js-read", "shell", "network", "agent.start", "send", "paid-model"]) {
    expect(TriggerActions.parse([{ kind, approved: true }]).ok).toBe(false)
  }
  expect(TriggerActions.parse([{ kind: "orchestra.status", shell: "echo bad" }]).ok).toBe(false)
})
test("read-only plan uses exact session ID and bounded results/time, never a session name", () => {
  expect(TriggerActions.parse([{ kind: "browser.read", sessionID: "browser_1", format: "text" }])).toEqual({ ok: true, actions: [{ kind: "browser.read", sessionID: "browser_1", format: "text", timeoutMs: 2000, maxChars: 3000 }] })
  for (const extra of [{ timeoutMs: 999999 }, { maxChars: 999999 }, { sessionID: "../../profile" }, { format: "eval" }]) expect(TriggerActions.parse([{ kind: "browser.read", sessionID: "b", format: "text", ...extra }]).ok).toBe(false)
  expect(TriggerActions.parse(Array.from({ length: 6 }, () => ({ kind: "orchestra.status" }))).ok).toBe(false)
})
test("legacy wake-only records retain frequency caps and unknown actions fail closed on reload", () => {
  const made = Trigger.create({ kind: "interval", spec: "10", prompt: "Read status" }, { id: "t", projectID: "p", now: 1000, existing: 0 })
  if (!made.ok) throw new Error(made.error)
  expect(made.trigger.maxPerHour).toBe(6)
  expect(made.trigger.maxPerDay).toBe(48)
  expect(Trigger.parse(made.trigger)?.actions).toBeUndefined()
  expect(Trigger.parse({ ...made.trigger, actions: [{ kind: "shell" }] })).toBeUndefined()
})
test("action errors pause after three consecutive failures and successful execution does not erase totals", () => {
  let errors = TriggerActions.emptyErrors()
  for (let n = 0; n < 3; n++) errors = TriggerActions.recordFailure(errors, n)
  expect(TriggerActions.mustPause(errors)).toBe(true)
  expect(TriggerActions.recordSuccess(errors)).toEqual({ consecutive: 0, total: 3, lastAt: 2 })
})
