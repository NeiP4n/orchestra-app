import { expect, test } from "bun:test"
import { limitExpansion, steppedLimit } from "../src/util/security-change"
import { readFileSync } from "node:fs"
test("left tightens, right expands without wrap and unlimited needs expansion",()=>{
 expect(steppedLimit(6,-1)).toBe(5);expect(steppedLimit(6,1)).toBe(7);expect(steppedLimit(1,-1)).toBe(1)
 expect(steppedLimit(100,1,true)).toBe(100);expect(steppedLimit(10000,1)).toBeNull();expect(steppedLimit(null,-1)).toBe(6)
 expect(limitExpansion(6,7)).toBe(true);expect(limitExpansion(6,null)).toBe(true);expect(limitExpansion(null,6)).toBe(false)
})
test("real security dialog binds left/right and confirms every permission or cap expansion",()=>{
 const source=readFileSync(new URL("../src/component/dialog-security.tsx",import.meta.url),"utf8")
 expect(source).toContain('bind:"left"');expect(source).toContain('run:()=>change(-1)');expect(source).toContain('bind:"right"');expect(source).toContain('run:()=>change(1)')
 expect(source).toContain('answer.trim()==="РАЗРЕШИТЬ"');expect(source).toContain('limitExpansion(current,next)')
 expect(source).toContain('ScheduleView.requestDailyLimit(item.id,owner,next!)');expect(source).toContain('задаётся окружением')
 expect(source).not.toContain('process.env[')
})
