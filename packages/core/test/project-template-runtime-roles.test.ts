import { expect, test } from "bun:test"
import path from "node:path"
import { Agent } from "@orchestra/schema/agent"
import { ProjectTemplateRuntimeRoles as Runtime } from "../src/project-template-runtime-roles"
import { ProjectTemplateV2 as V2 } from "../src/project-template-v2"
import { ProjectTemplateV2Plan as Plan } from "../src/project-template-v2-plan"
import { processFixture } from "./project-template-v2.test"

test("runtime snapshot binds every permission and request setting without exposing owned plan paths",()=>{
 const base=Agent.Info.default(Agent.ID.make("plan"))
 const agent:Agent.Info={...base,permissions:[...base.permissions,{action:"edit",resource:path.join("/source/config","plan","*"),effect:"allow"}],system:"Keep source constraints"}
 const roots={config:"/source/config",home:"/source/home"},role=Runtime.portable(agent,roots)
 expect(role.runtime?.permissions).not.toContainEqual(expect.objectContaining({resource:path.join(roots.config,"plan","*")}))
 expect(role.runtime?.permissions.at(-1)?.resource).toBe("{{runtime.planDirectory}}/*")
 for(const mutate of [
  (a:Agent.Info)=>({...a,permissions:[]}),
  (a:Agent.Info)=>({...a,system:"Different instruction"}),
  (a:Agent.Info)=>({...a,request:{...a.request,body:{temperature:0.5}}}),
 ]){
  const changed=mutate(structuredClone(agent))
  expect(Runtime.portable(changed,roots).runtime).not.toEqual(role.runtime)
  expect(()=>Runtime.merge([[agent],[changed]],roots)).toThrow("differs")
 }
 expect(Runtime.merge([[agent],[structuredClone(agent)]],roots)).toEqual([role])
 const targetRoots={config:"/friend/config",home:"/friend/home"}
 const otherHost:Agent.Info={...agent,permissions:agent.permissions.map(r=>r.resource===path.join(roots.config,"plan","*")?{...r,resource:path.join(targetRoots.config,"plan","*")}:r)}
 expect(Runtime.portable(otherHost,targetRoots)).toEqual(role)
 const customAbsolute:Agent.Info={...agent,permissions:[{action:"edit",resource:"/unrelated/private/*",effect:"deny"}]}
 expect(V2.preview(JSON.stringify({...processFixture(),process:{...processFixture().process,roles:[Runtime.portable(customAbsolute,roots)]}})).ok).toBe(false)
})

test("runtime roles are reused exactly, never installed as weaker team roles",()=>{
 const agent=Agent.Info.default(Agent.ID.make("build")),role=Runtime.portable(agent),b=processFixture()
 b.process.roles.push(role);b.sessions.push({slot:"runtime",title:"Worker",role:"build",model:null});b.process.sessionModels.push({session:"runtime",models:[]})
 const preview=V2.preview(JSON.stringify(b));expect(preview.ok).toBe(true);if(!preview.ok)throw Error(preview.error)
 const d:Plan.Destination={projectID:"prj_target",installedVersion:"1.0.0",reviewedDigest:preview.value.digest,roles:[...b.process.roles],skills:[],models:new Set(),programs:new Set(),mcp:new Map(),providers:new Set()}
 const plan=Plan.prepare(preview.value.text,d),selected=plan.roles.find(r=>r.source==="build")!
 expect(selected.action).toBe("reuse-runtime");expect(selected.target).toBe("build")
 expect(plan.remapped.sessions.find(s=>s.slot==="runtime")?.role).toBe("build")
 const changed={...d,roles:d.roles.filter(r=>r.agent!=="build")}
 expect(Plan.prepare(preview.value.text,changed).requirements.coreRoleDifferences).toContain("build")
 expect(Plan.prepare(preview.value.text,{...d,roles:d.roles.map(r=>r.agent==="build"?{...r,runtime:{...agent,permissions:[]}}:r)}).requirements.coreRoleDifferences).toContain("build")
})
