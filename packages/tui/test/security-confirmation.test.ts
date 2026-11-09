import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pendingApprovals, saveApproval, removeApproval } from "../src/util/security-confirmation"
test("confirmation stores a request, never approval, and validates the kind and bounds",()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),"confirm-test-")),previous=process.env.ORCHESTRA_STATE_DIR;process.env.ORCHESTRA_STATE_DIR=dir
 try{const saved=saveApproval({kind:"permissions",before:"prompt",next:"autoaccept"});expect(pendingApprovals()).toEqual([saved]);expect(saved).not.toHaveProperty("approved");removeApproval(saved.id);expect(pendingApprovals()).toEqual([]);expect(()=>saveApproval({kind:"day",sessionID:"main",triggerID:"t",before:48,next:101})).toThrow()}finally{if(previous===undefined)delete process.env.ORCHESTRA_STATE_DIR;else process.env.ORCHESTRA_STATE_DIR=previous;rmSync(dir,{recursive:true,force:true})}
})
