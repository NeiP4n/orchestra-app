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
 expect(source).toContain('if(answer.trim()!=="РАЗРЕШИТЬ")return');expect(source).toContain('limitExpansion(current,next)')
 expect(source).toContain('ScheduleView.requestDailyLimit(item.id,owner,next!)');expect(source).toContain('задано окружением')
 expect(source).not.toContain('process.env[')
})

test("full-disable is operator-only, acknowledged and globally visible with one action restore",()=>{
 const source=readFileSync(new URL("../src/component/dialog-security.tsx",import.meta.url),"utf8")
 expect(source).toContain('safety:"all"');expect(source).toContain('SafetyConfig.write(JSON.parse(request.next as string),"РАЗРЕШИТЬ")')
 const bar=readFileSync(new URL("../src/component/safety-warning-bar.tsx",import.meta.url),"utf8")
 expect(bar).toContain('SafetyConfig.restore()');expect(bar).toContain('защита лимитов ВЫКЛЮЧЕНА')
 const app=readFileSync(new URL("../src/app.tsx",import.meta.url),"utf8")
 expect(app).toContain('<SafetyWarningBar />')
})
