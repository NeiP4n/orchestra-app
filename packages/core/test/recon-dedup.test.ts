import {expect,test} from "bun:test"
import {ReconDedup} from "../src/recon-dedup"
test("recon dedup matches exact unchanged supplied content only",()=>{
 const attached=[{type:"text",text:"src/a.ts\n1: old"}]
 const hashes=[ReconDedup.digest(attached)]
 expect(ReconDedup.duplicate(attached,hashes)).toBe(true)
 expect(ReconDedup.duplicate([{type:"text",text:"src/a.ts\n1: new"}],hashes)).toBe(false)
 expect(ReconDedup.duplicate([{type:"text",text:"src/a.ts\n2: old"}],hashes)).toBe(false)
 expect(ReconDedup.duplicate(attached,["forged"])).toBe(false)
 expect(ReconDedup.duplicate(attached,undefined)).toBe(false)
})
