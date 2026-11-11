import { expect, test } from "bun:test"
import { limitExpansion, steppedLimit, parseSecurityNumber } from "../src/util/security-change"
import { readFileSync } from "node:fs"
test("left tightens, right expands without wrap and unlimited needs expansion",()=>{
 expect(steppedLimit(6,-1)).toBe(5);expect(steppedLimit(6,1)).toBe(7);expect(steppedLimit(1,-1)).toBe(1)
 expect(steppedLimit(100,1,true)).toBe(100);expect(steppedLimit(10000,1)).toBeNull();expect(steppedLimit(null,-1)).toBe(6)
 expect(limitExpansion(6,7)).toBe(true);expect(limitExpansion(6,null)).toBe(true);expect(limitExpansion(null,6)).toBe(false)
})
test("real security dialog binds left/right and applies every operator permission or cap expansion immediately",()=>{
 const source=readFileSync(new URL("../src/component/dialog-security.tsx",import.meta.url),"utf8")
 expect(source).toContain('bind:"left"');expect(source).toContain('run:()=>change(-1)');expect(source).toContain('bind:"right"');expect(source).toContain('run:()=>change(1)')
 expect(source).not.toContain("РАЗРЕШИТЬ");expect(source).not.toContain("DialogPrompt");expect(source).not.toContain("saveApproval");expect(source).toContain("SafetyConfig.write(next)")
 expect(source).toContain('ScheduleView.requestDailyLimit(item.id,owner,next!)');expect(source).toContain('задано окружением')
 expect(source).not.toContain('process.env[')
})

test("full-disable is operator-only, recorded and visible in Security only with one action restore",()=>{
 const source=readFileSync(new URL("../src/component/dialog-security.tsx",import.meta.url),"utf8")
 expect(source).toContain('safety:"all"');expect(source).toContain('SafetyConfig.restore()')
 const bar=readFileSync(new URL("../src/component/safety-warning-bar.tsx",import.meta.url),"utf8")
 expect(bar).toContain('SafetyConfig.restore()');expect(bar).toContain('защита лимитов ВЫКЛЮЧЕНА')
 const app=readFileSync(new URL("../src/app.tsx",import.meta.url),"utf8")
 expect(app).not.toContain('SafetyWarningBar')
 expect(source).toContain('ВЫКЛЮЧЕНА · расширено')
})

test("fast steps and direct numbers keep original schedule bounds and accept millions for token limits",()=>{
 expect(steppedLimit(6,1,false,100)).toBe(106);expect(steppedLimit(48,1,true,100)).toBe(100)
 expect(parseSecurityNumber("100000000")).toBe(100000000)
 for(const bad of ["", "-1", "1.5", "1e9", "9007199254740992"])expect(parseSecurityNumber(bad)).toBeUndefined()
 expect(parseSecurityNumber("101",100)).toBeUndefined();expect(parseSecurityNumber("100",100)).toBe(100)
 const source=readFileSync(new URL("../src/component/dialog-security.tsx",import.meta.url),"utf8")
 for(const binding of ["shift+left","shift+right","pageup","pagedown","backspace"])expect(source).toContain(binding)
 expect(source).toContain("inputDigit(String(i))");expect(source).toContain("numberValue(value)")
})
