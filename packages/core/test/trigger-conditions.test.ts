import { expect, test } from "bun:test"
import { Trigger } from "@orchestra/core/trigger"
import { TriggerConditions } from "@orchestra/core/trigger-conditions"
const context = { id: "t", projectID: "p", now: 1000, existing: 0 }
const create = (condition: unknown, actions: unknown = [{ kind: "orchestra.status" }]) => Trigger.create({ kind: "", spec: "", prompt: "Record event", condition, actions }, context)
test("explicit condition vocabulary and conflicting legacy fields fail closed", () => {
  expect(TriggerConditions.parse({ type: "orchestra", event: "shell", sessionID: "s" })).toBeUndefined()
  expect(TriggerConditions.parse({ type: "browser", event: "incoming-row", sessionID: "s", approved: true })).toBeUndefined()
  expect(Trigger.create({ kind: "once", spec: "bad", prompt: "p", condition: { type: "time", kind: "interval", spec: "10" } }, context).ok).toBe(false)
  expect(create({ type: "time", kind: "interval", spec: "10" }).ok).toBe(true)
  expect(create({ type: "browser", event: "incoming-row", sessionID: "b" }).ok).toBe(true)
  expect(create({ type: "time", kind: "interval", spec: "10" }, [{ kind: "browser.read", sessionID: "b", format: "text" }]).ok).toBe(false)
})
test("internal source is exact, has a five minute gap and normal caps, never implicit AI wake", () => {
  const made = create({ type: "orchestra", event: "execution.failed", sessionID: "worker_1" })
  if (!made.ok) throw Error(made.error)
  expect(Trigger.parse(made.trigger)?.condition?.type).toBe("orchestra")
  expect(Trigger.internalDue(made.trigger, { sessionID: "other", event: "execution.failed" }, 1000)).toBe("wait")
  expect(Trigger.internalDue(made.trigger, { sessionID: "worker_1", event: "execution.failed" }, 1000)).toBe("fire")
  const fired = Trigger.afterFire(made.trigger, 1000)
  expect(fired.nextAt).toBeNull()
  expect(Trigger.internalDue(fired, { sessionID: "worker_1", event: "execution.failed" }, 2000)).toBe("wait")
  expect(Trigger.internalDue({ ...fired, maxPerHour: 1 }, { sessionID: "worker_1", event: "execution.failed" }, 301000)).toBe("pause")
  expect(create({ type: "orchestra", event: "execution.failed", sessionID: "worker_1" }, []).ok).toBe(false)
})
test("real local action results preserve cumulative errors and pause on third failure", async () => {
  const made = create({ type: "orchestra", event: "execution.succeeded", sessionID: "worker_1" })
  if (!made.ok) throw Error(made.error)
  let row = made.trigger
  for (let n = 0; n < 3; n++) row = await Trigger.executeLocal(row, n, () => { throw Error("disk failed") })
  expect(row.enabled).toBe(false)
  expect(row.errors?.total).toBe(3)
  const logs: unknown[] = []
  const success = await Trigger.executeLocal({ ...row, enabled: true }, 4, (entry) => { logs.push(entry) })
  expect(success.errors?.consecutive).toBe(0)
  expect(success.errors?.total).toBe(3)
  expect(logs).toHaveLength(1)
})

test("internal event wiring is bounded and does not create model turns or browser actions", async () => {
  const { readFileSync } = await import("node:fs")
  const source = readFileSync(new URL("../src/orchestra.ts", import.meta.url), "utf8")
  const start = source.indexOf("const internalInbox:")
  const block = source.slice(start, source.indexOf("// Triggers (a cron time", start))
  expect(block).toContain("internalInbox.length < 200")
  expect(block).toContain("SessionEvent.Execution.Succeeded, SessionEvent.Execution.Failed")
  expect(block).toContain("Trigger.internalDue")
  expect(block).toContain("owns(project, source)")
  expect(block).not.toContain(".synthetic(")
  expect(block).not.toContain("BrowserRuntime.open(")
  expect(block).not.toContain("eval(")
})
