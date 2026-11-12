import { expect,test } from "bun:test"
import { ProjectTemplateCoreMigration as Migration } from "../src/project-template-core-migration"
import { processFixture } from "./project-template-v2.test"
test("reviewed copy replaces only reserved definitions and exposes field/hash differences",()=>{
 const original=processFixture(), before=JSON.stringify(original)
 const current=[{...original.process.roles[0],rules:"Current server fingerprint",tools:["read"],autoTools:false}]
 const result=Migration.prepare(before,current)
 expect(result.changes).toHaveLength(1)
 expect(result.changes[0]).toMatchObject({role:"orchestrator",fields:["autoTools","rules","tools"]})
 expect(result.changes[0].fromHash).toMatch(/^[a-f0-9]{64}$/)
 expect(result.changes[0].toHash).not.toBe(result.changes[0].fromHash)
 expect(result.bundle.process.roles[0]).toEqual(current[0])
 const restored=structuredClone(result.bundle);restored.process.roles[0]=original.process.roles[0]
 expect(restored).toEqual(original)
 expect(JSON.stringify(original)).toBe(before)
 expect(()=>Migration.prepare(before,[])).toThrow("unavailable")
 expect(()=>Migration.prepare(before,[...current,...current])).toThrow("ambiguous")
 expect(Migration.fingerprint({b:2,a:1})).toBe(Migration.fingerprint({a:1,b:2}))
})
