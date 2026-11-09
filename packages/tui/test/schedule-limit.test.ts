import {expect,test} from "bun:test"
import {parseScheduleLimit} from "../src/util/schedule-limit"
test("sidebar numbers need no word; old pasted prefix is tolerated; day and hour bounds stay separate",()=>{
 expect(parseScheduleLimit("100")).toBe(100);expect(parseScheduleLimit("1000")).toBe(1000)
 expect(parseScheduleLimit("РАЗРЕШИТЬ 100")).toBe(100);expect(parseScheduleLimit("РАЗРЕШИТЬ\n100")).toBe(100)
 expect(parseScheduleLimit("РАЗРЕШИТЬ")).toBeUndefined();expect(parseScheduleLimit("100",true)).toBe(100)
 expect(parseScheduleLimit("101",true)).toBeUndefined();expect(parseScheduleLimit("без лимита",true)).toBeUndefined()
 expect(parseScheduleLimit("без лимита")).toBeNull();expect(parseScheduleLimit("10001")).toBeUndefined()
})
