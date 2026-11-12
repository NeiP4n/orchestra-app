import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ProjectTemplateOperator } from "../src/project-template-operator"
import { ProjectTemplateTransfer } from "../src/project-template-transfer"
import { ProjectTemplateV2Library } from "../src/project-template-v2-library"
import { processFixture } from "./project-template-v2.test"
test("reimporting the same real template file reuses content, old duplicates are hidden without deleting data", async () => {
 const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "dedup-template-")))
 try {
  const values = new Map<string, any>()
  const kv = {get:(k:string)=>Effect.sync(()=>values.get(k)),set:(k:string,v:any)=>Effect.sync(()=>{values.set(k,v)}),atomicUpdate:(k:string,fn:any)=>Effect.sync(()=>{const v=fn(values.get(k));values.set(k,v);return v})}
  const operator = ProjectTemplateOperator.make({kv,store:{},dataDirectory:root,installedVersion:"1.0.0",processStores:()=>{throw Error("unused")},live:()=>{throw Error("unused")}} as never)
  const file=await ProjectTemplateTransfer.write(root,JSON.stringify(processFixture()))
  const a=await operator.prepareImport(' "'+file.path+'" '), b=await operator.prepareImport(file.path)
  const [first,second]=await Promise.all([operator.confirmImport(a.token),operator.confirmImport(b.token)])
  expect(first.id).toBe(second.id)
  const library=ProjectTemplateV2Library.local(root), preview=await ProjectTemplateTransfer.read(file.path)
  await library.saveSerialized(preview.text,"old_duplicate",preview.digest)
  expect((await library.list()).filter(r=>r.state==="ready")).toHaveLength(2)
  expect(await operator.list()).toHaveLength(1)
  const changed=processFixture();changed.description="Different configuration with same name"
  const next=await ProjectTemplateTransfer.write(root,JSON.stringify(changed)), c=await operator.prepareImport(next.path)
  await operator.confirmImport(c.token)
  expect(await operator.list()).toHaveLength(2)
  expect(ProjectTemplateTransfer.normalizePath(' "C:\\Users\\Isako\\Desktop\\Test2.orchestra-template" ')).toBe('C:\\Users\\Isako\\Desktop\\Test2.orchestra-template')
 } finally { await rm(root,{recursive:true,force:true}) }
})
