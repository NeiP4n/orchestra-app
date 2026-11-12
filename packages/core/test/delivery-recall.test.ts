import {expect,test} from "bun:test"
import {execFile} from "node:child_process"
import {promisify} from "node:util"
import {mkdtemp,rm,writeFile} from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {DeliveryRecall} from "../src/delivery-recall"
const exec=promisify(execFile)
test("live delivery checkpoint exposes past commits and refuses invented code delivery refs",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"delivery-recall-"))
 const git=(args:string[])=>exec("git",args,{cwd:root})
 try{
  await git(["init","-q"]);await git(["config","user.name","Fixture"]);await git(["config","user.email","fixture@example.invalid"])
  await writeFile(path.join(root,"a.txt"),"prior fix");await git(["add","a.txt"]);await git(["commit","-qm","prior coordination fix"])
  await git(["branch","delivered-fix"])
  const state=await DeliveryRecall.inspect(root)
  expect(state?.commits).toContain("prior coordination fix")
  expect(DeliveryRecall.block(state)).toContain("Before repeating past DONE")
  expect(await DeliveryRecall.verify(root,`DONE SHA: ${state!.head}`)).toBe(true)
  expect(await DeliveryRecall.verify(root,"DONE branch: delivered-fix")).toBe(true)
  expect(await DeliveryRecall.verify(root,"DONE SHA: aaaaaaaa")).toBe(false)
  expect(await DeliveryRecall.verify(root,"DONE branch: invented")).toBe(false)
  expect(await DeliveryRecall.verify(root,"DONE только локально")).toBe(true)
 }finally{await rm(root,{recursive:true,force:true})}
})
