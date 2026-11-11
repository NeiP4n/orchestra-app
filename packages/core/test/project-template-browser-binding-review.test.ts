import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ProjectTemplateReader as Reader } from "../src/project-template-reader"
import { ProjectTemplateOperator as Operator } from "../src/project-template-operator"
import { ProjectTemplateSource as Source } from "../src/project-template-source"
import { templateDiagnosticOf, templateError } from "../src/project-template-errors"

function fixture() {
  const p2={id:"prj_test2",name:"Test2",directory:"/test2",main:"ses_main",created:1}
  const p3={id:"prj_test3",name:"Test3",directory:"/test3",main:"ses_other",created:2}
  const values = new Map<string,unknown>([["orchestra/project/"+p2.id,p2],["orchestra/project/"+p3.id,p3]])
  const sessions = new Map<string,Reader.SessionMetadata>([
    ["ses_main",{id:"ses_main",title:"Orchestrator",agent:"orchestrator",location:{directory:p2.directory}}],
    ["ses_auto",{id:"ses_auto",title:"Приветствие auto",location:{directory:p2.directory}}],
    ["ses_browser",{id:"ses_browser",title:"Whatsapp",agent:"team-browser-agent",location:{directory:p2.directory}}],
    ["ses_foreign",{id:"ses_foreign",title:"FOREIGN_CANARY",agent:"team-browser-agent",location:{directory:p2.directory}}],
    ["ses_child",{id:"ses_child",parentID:"ses_main",title:"CHILD_CANARY",location:{directory:p2.directory}}],
    ["ses_outside",{id:"ses_outside",title:"OUTSIDE_CANARY",location:{directory:"/outside"}}],
  ])
  for(const id of ["ses_main","ses_auto","ses_browser"]) values.set("orchestra/owner/"+id,p2.id)
  values.set("orchestra/owner/ses_foreign",p3.id)
  const kv = {
    get:(key:string)=>Effect.sync(()=>values.get(key)),
    set:(key:string,value:unknown)=>Effect.sync(()=>{values.set(key,value)}),
    scan:({prefix}:{prefix:string})=>Effect.sync(()=>({entries:[...values].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value}))})),
    atomicUpdate:(key:string,fn:(value:unknown)=>unknown)=>Effect.sync(()=>{const next=fn(values.get(key));values.set(key,next);return next}),
  }
  const stores:Reader.Stores={kv,getSession:id=>Effect.sync(()=>sessions.get(id)),listSessionsInTree:()=>Effect.succeed([...sessions.values()].filter(s=>s.location.directory===p2.directory))}
  // OFF is runtime state in the owning Browser UI. Export receives only persisted
  // definitions and therefore must treat powered-off and live browsers identically.
  const browsers=[{id:"brw_whatsapp",name:"Whatsapp",mode:"window" as const,chat:"ses_browser"},{id:"brw_second",name:"Browser 2",mode:"window" as const,chat:"ses_auto"}]
  const linked={browsers:browsers.map(b=>({...b,projectID:p2.id,savedLinks:[]})),vault:[],selectedGlobalSlotIDs:new Set<string>(),providers:[],mcp:[]}
  return {values,sessions,kv,stores,browsers,linked,p2}
}
const metadata={name:"Test2",description:"Configuration only",minOrchestraVersion:"1.0.0"}

test("Test2/Test3 with two powered-off browsers and a legacy auto chat preserves both bindings", async()=>{
 const f=fixture(), snapshot=JSON.stringify([...f.values])
 const result=await Effect.runPromise(Reader.capture(f.stores,f.p2.id,metadata,f.linked))
 expect(result.bundle.browsers).toHaveLength(2)
 expect(result.bundle.browsers.every(b=>!!b.session)).toBe(true)
 const auto=result.bundle.sessions.find(s=>s.title==="Приветствие auto")!
 expect(auto.role).toBeNull()
 expect(result.bundle.browsers[1].session).toBe(auto.slot)
 expect(result.text).not.toContain("CANARY")
 expect(JSON.stringify([...f.values])).toBe(snapshot)
})

for(const [chat,reason] of [["ses_deleted","missing"],["ses_child","child"],["ses_foreign","foreign"],["ses_outside","unlisted"]] as const) test(`Test2 stale browser binding ${reason}: reproduce old failure, diagnose, require review and never export foreign data`,async()=>{
 const f=fixture(), root=await realpath(await mkdtemp(path.join(os.tmpdir(),"browser-owner-")))
 try {
  f.browsers[0].chat=chat;f.linked.browsers[0].chat=chat
  const snapshot=JSON.stringify([...f.values])
  // Reproduce the exact prior failure on the pure base projection.
  const oldSource=await Effect.runPromise(Reader.readSource(f.stores,f.p2.id,{...f.linked,browsers:[]}))
  const old=Source.capture({...oldSource,browsers:f.linked.browsers},metadata)
  expect(old.ok).toBe(false)
  if(!old.ok) expect(old.diagnostic).toEqual({stage:"base-browsers",reasonCode:"ownership-invalid"})
  const strict=await Effect.runPromise(Reader.capture(f.stores,f.p2.id,metadata,f.linked)).then(()=>undefined,e=>e)
  expect(templateDiagnosticOf(strict)).toEqual({stage:"base-browsers",reasonCode:`browser-chat-${reason}`})
  expect(templateError(strict).kind).toBe(`TEMPLATE_BROWSER_CHAT_${reason.toUpperCase()}`)
  const review:Reader.BrowserBindingIssue[]=[]
  const source=await Effect.runPromise(Reader.readSource(f.stores,f.p2.id,f.linked,review))
  expect(review).toEqual([{browser:1,reason}])
  expect(source.browsers[0].chat).toBeUndefined()
  expect(source.browsers[1].chat).toBe("ses_auto")
  expect(JSON.stringify([...f.values])).toBe(snapshot)
  const operator=Operator.make({kv:f.kv,store:{get:f.stores.getSession,list:()=>f.stores.listSessionsInTree("/test2")},dataDirectory:root,installedVersion:"1.0.0",live:()=>{throw Error("must not create")}} as never)
  const prepared=await operator.prepareSave(f.p2.id,f.browsers)
  expect(prepared.browserBindings).toEqual([{browser:1,reason}])
  expect(JSON.parse(prepared.details).browsers.map((b:{name:string})=>b.name)).toEqual(["Whatsapp","Browser 2"])
  expect(prepared.details).not.toContain("CANARY")
  await expect(operator.confirmSave(prepared.token,f.browsers)).rejects.toThrow("Browser bindings require review")
  expect(await operator.list()).toEqual([])
  await operator.confirmSave(prepared.token,f.browsers,false,true)
  expect(await operator.list()).toHaveLength(1)
  expect(f.values.get("orchestra/owner/ses_foreign")).toBe("prj_test3")
  expect(f.browsers[0].chat).toBe(chat)
 } finally {await rm(root,{recursive:true,force:true})}
})

test("review cannot approve a different stale binding after preview",async()=>{
 const f=fixture(), root=await realpath(await mkdtemp(path.join(os.tmpdir(),"browser-race-")))
 try {
  f.browsers[0].chat="ses_deleted"
  const operator=Operator.make({kv:f.kv,store:{get:f.stores.getSession,list:()=>f.stores.listSessionsInTree("/test2")},dataDirectory:root,installedVersion:"1.0.0",live:()=>{throw Error("must not create")}} as never)
  const prepared=await operator.prepareSave(f.p2.id,f.browsers)
  f.browsers[0].chat="ses_deleted_other"
  await expect(operator.confirmSave(prepared.token,f.browsers,false,true)).rejects.toThrow("Project changed")
  expect(await operator.list()).toEqual([])
 } finally {await rm(root,{recursive:true,force:true})}
})
