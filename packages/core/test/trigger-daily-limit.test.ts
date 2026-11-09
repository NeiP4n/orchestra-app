import { expect, test } from "bun:test"
import { Trigger } from "@orchestra/core/trigger"
const now=Date.parse("2026-11-10T00:00:00Z")
test("daily operator bound persists and preserves history, pauses, hour and publishing",()=>{
 const m=Trigger.create({kind:"interval",spec:"5",prompt:"Read"},{id:"t",projectID:"p",now,existing:0});if(!m.ok)throw Error(m.error)
 const t={...m.trigger,enabled:false,pausedReason:"operator pause",fired:[now-1000]},next=Trigger.withDailyLimit(t,3,now)
 expect(Trigger.parse(JSON.parse(JSON.stringify(next)))?.maxPerDay).toBe(3)
 expect(next.fired).toEqual(t.fired);expect(next.enabled).toBe(false);expect(next.pausedReason).toBe(t.pausedReason);expect(next.maxPerHour).toBe(t.maxPerHour);expect(next.publishApproved).toBe(false)
 for(const value of [0,101,NaN,1.5])expect(()=>Trigger.withDailyLimit(t,value,now)).toThrow()
})
