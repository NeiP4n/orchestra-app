import { expect, test } from "bun:test"
import { Trigger } from "@orchestra/core/trigger"
import { TriggerMissed as M } from "@orchestra/core/trigger-missed"
const now=Date.parse("2026-11-10T00:00:00Z")
const make=(kind="interval",spec="5")=>{const m=Trigger.create({kind,spec,prompt:"Read"},{id:"t",projectID:"p",now,existing:0});if(!m.ok)throw Error(m.error);return m.trigger}
test("normal minute sweep jitter is not a missed run",()=>{const t=make();expect(M.plan(t,t.nextAt!+60_000)).toBe(t)})
test("default periodic policy skips downtime slots without firing or resetting caps",()=>{const t=make(), p=M.plan(t,now+60*60_000,"UTC");expect(p.missedCount).toBe(12);expect(p.total).toBe(0);expect(p.nextAt).toBe(now+65*60_000);expect(p.fired).toEqual(t.fired)})
test("one-shot runs once within 24h grace, then visibly expires",()=>{const t=make("once",new Date(now+1000).toISOString());expect(M.plan(t,now+3600_000)).toBe(t);const p=M.plan(t,now+25*3600_000);expect(p.enabled).toBe(false);expect(p.missedCount).toBe(1)})
test("catch-up is max3, durable and returns to future without unbounded loop",()=>{const t={...make(),missedPolicy:"catch-up" as const};let p=M.plan(t,now+60*60_000,"UTC");expect(p.catchUpRemaining).toBe(3);expect(p.missedCount).toBe(9);for(let i=0;i<3;i++)p=Trigger.afterFire(p,now+60*60_000,"UTC");expect(p.total).toBe(3);expect(p.catchUpRemaining).toBeUndefined();expect(p.nextAt).toBe(now+65*60_000)})
