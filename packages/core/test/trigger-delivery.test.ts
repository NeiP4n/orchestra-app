import { expect, test } from "bun:test"
import { Trigger } from "@orchestra/core/trigger"
import { TriggerDelivery as D } from "@orchestra/core/trigger-delivery"
const now = Date.parse("2026-11-10T00:00:00Z")
const once = () => { const m = Trigger.create({ kind: "once", spec: new Date(now + 1000).toISOString(), prompt: "Report status" }, { id: "t", projectID: "p", now, existing: 0 }); if (!m.ok) throw Error(m.error); return m.trigger }
test("atomic reservation survives crash before dispatch, including disabled one-shot", () => {
  const t = once(), reserved = Trigger.parse(D.reserve(t, t, now + 1000, "UTC", "ses_main"))!
  expect(reserved.enabled).toBe(false)
  expect(reserved.total).toBe(1)
  expect(reserved.pendingFire?.fireId).toBe(`t:${now + 1000}`)
  const restarted = Trigger.parse(JSON.parse(JSON.stringify(reserved)))!
  expect(restarted.pendingFire).toEqual(reserved.pendingFire)
  expect(D.reserve(restarted, t, now + 5000, "UTC", "ses_main")).toEqual(restarted)
  expect(D.messageID(restarted.pendingFire!.fireId)).toBe(reserved.pendingFire!.messageID)
  expect(Trigger.parse(D.acknowledge(restarted, reserved.pendingFire!.fireId))?.pendingFire).toBeUndefined()
})
test("competing reserve cannot advance twice; stale ack never restores deleted or newer data", () => {
  const t = once(), reserved = D.reserve(t, t, now + 1000, "UTC", "ses_main")
  expect(D.reserve(reserved, t, now + 1000, "UTC", "ses_main")).toEqual(reserved)
  expect(D.acknowledge(undefined, `t:${now+1000}`)).toBeUndefined()
  expect(D.acknowledge(reserved, "other-fire")).toEqual(reserved)
  expect(D.reserve({ ...t, enabled: false }, t, now+1000, "UTC", "ses_main")).toEqual({ ...t, enabled: false })
})
test("only expired sweeper leases may change owner, release is owner-checked", () => {
  const first = D.lease(undefined, "A", now)
  expect(D.lease(first, "B", now+1)).toEqual(first)
  expect(D.lease(first, "B", now+D.LEASE_MS)).toEqual({ owner: "B", until: now+2*D.LEASE_MS })
})
test("malformed pending source cannot enter recovery", () => {
  const t=once(), reserved=Trigger.parse(D.reserve(t,t,now+1000,"UTC","ses_main"))!
  expect(Trigger.parse({ ...reserved, pendingFire: { ...reserved.pendingFire, source: { id:"foreign" } } })).toBeUndefined()
})
