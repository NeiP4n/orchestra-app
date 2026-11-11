import { expect, test } from "bun:test"
import { Effect } from "effect"
import { realpath, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { ProjectTemplateOperator } from "../src/project-template-operator"
import { ProjectTemplateLibrary } from "../src/project-template-library"

test("v1 update binds old and new digests, rechecks source, keeps ID and is idempotent", async () => {
 const data=await realpath(await mkdtemp(path.join(tmpdir(),"template-update-v1-")))
 try {
  let name="Factory"
  const values=new Map<string,any>([["orchestra/owner/ses_main","prj_a"]])
  const project=()=>({id:"prj_a",name,directory:"/work",created:1,main:"ses_main"})
  const kv={get:(key:string)=>Effect.sync(()=>key==="orchestra/project/prj_a"?project():values.get(key)),set:(key:string,value:any)=>Effect.sync(()=>{values.set(key,value)}),scan:({prefix}: {prefix:string})=>Effect.sync(()=>({entries:[...[...values].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value})),...(prefix==="orchestra/project/"?[{key:"orchestra/project/prj_a",value:project()}]:[])]})),atomicUpdate:(key:string,fn:(value:any)=>any)=>Effect.sync(()=>{const next=fn(values.get(key));values.set(key,next);return next})}
  const main={id:"ses_main",title:"Main",agent:"orchestrator",location:{directory:"/work"}}
  const operator=ProjectTemplateOperator.make({kv,store:{get:()=>Effect.succeed(main),list:()=>Effect.succeed([main])},dataDirectory:data,installedVersion:"1.0.0",live:()=>{throw Error("must not create project")}} as never)
  const save=await operator.prepareSave("prj_a",[])
  await operator.confirmSave(save.token,[])
  const [entry]=await operator.list()
  name="Intermediate"
  const stale=await operator.prepareSave("prj_a",[],entry.id)
  name="Final"
  await expect(operator.confirmSave(stale.token,[])).rejects.toThrow("Project changed")
  const update=await operator.prepareSave("prj_a",[],entry.id)
  expect(update.name).toBe("Factory")
  expect(JSON.parse(update.details).version).toBe(1)
  await operator.confirmSave(update.token,[])
  await operator.confirmSave(update.token,[])
  expect(await operator.list()).toEqual([{id:entry.id,name:"Final"}])
  const library=ProjectTemplateLibrary.local(data)
  const prior=await library.preview(entry.id)
  name="Race A";const a=await operator.prepareSave("prj_a",[],entry.id)
  name="Race B";const b=await operator.prepareSave("prj_a",[],entry.id)
  await operator.confirmSave(b.token,[])
  await expect(operator.confirmSave(a.token,[])).rejects.toThrow("Template changed")
  expect((await library.preview(entry.id)).digest).not.toBe(prior.digest)
  expect(await operator.list()).toEqual([{id:entry.id,name:"Race B"}])
 } finally {await rm(data,{recursive:true,force:true})}
})
