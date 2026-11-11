import { expect, test } from "bun:test"
import { mkdtemp, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectTemplateTransfer as Transfer } from "../src/project-template-transfer"
import { processFixture } from "./project-template-v2.test"

test("one shareable file in project root roundtrips exact process bytes, never overwrites or scans project data",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"template-transfer-"))
 try{
  await writeFile(path.join(root,"PRIVATE_DATA.txt"),"PRIVATE_CANARY")
  const b=processFixture(),first=await Transfer.write(root,JSON.stringify(b)),second=await Transfer.write(root,JSON.stringify(b))
  expect(path.dirname(first.path)).toBe(await realpath(root));expect(first.path.endsWith(".orchestra-template")).toBe(true)
  expect(second.path).not.toBe(first.path)
  expect(first.warning).toContain("git")
  const value=await Transfer.read(first.path)
  expect(value.bundle).toEqual(b)
  expect(await readFile(first.path,"utf8")).not.toContain("PRIVATE_CANARY")
  await writeFile(first.path,"changed")
  await expect(Transfer.read(first.path)).rejects.toThrow()
 }finally{await rm(root,{recursive:true,force:true})}
})
test("transfer refuses symlink, invalid JSON, secret content and oversized files",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"template-transfer-"))
 try{
  const value=await Transfer.write(root,JSON.stringify(processFixture()))
  const link=path.join(root,"linked.orchestra-template")
  await symlink(value.path,link,process.platform==="win32"?"file":undefined)
  await expect(Transfer.read(link)).rejects.toThrow()
  const bad=path.join(root,"bad.orchestra-template")
  await writeFile(bad,"x".repeat(1048577));await expect(Transfer.read(bad)).rejects.toThrow()
  const b=processFixture();b.process.roles[0].rules="Use /private/source/file"
  await expect(Transfer.write(root,JSON.stringify(b))).rejects.toThrow()
 }finally{await rm(root,{recursive:true,force:true})}
})
