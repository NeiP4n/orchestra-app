import {expect,test} from "bun:test"
import {Effect} from "effect"
import {WorkspaceForgeTool as W} from "../src/tool/plugin/workspace-forge"
import {Orchestra as O} from "../src/orchestra"
import {Federation as F} from "../src/federation"
import {Permission as P} from "../src/permission"

test("workspace list scopes metadata and foreign create_group member requires confirm even link:false",async()=>{
 let tool:any;const checks:any[]=[]
 const projects=[{id:"prj_a",name:"Own",directory:"/own",main:"ses_a"},{id:"prj_b",name:"Same society",directory:"/b",main:"ses_b"},{id:"prj_c",name:"FOREIGN",directory:"/private",main:"ses_secret"}]
 const groups=[{name:"Own society",projects:["prj_a","prj_b"],supervisor:"ses_soc_a"},{name:"Foreign society",projects:["prj_c"],supervisor:"ses_soc_secret"}]
 const orchestra={mainOf:()=>Effect.succeed(projects[0]),projects:()=>Effect.succeed(projects),templates:()=>Effect.succeed([]),roles:()=>Effect.succeed([])} as any
 const federation={groups:()=>Effect.succeed(groups),linked:()=>Effect.succeed([])} as any
 const permission={confirm:(input:any)=>{checks.push(input);return Effect.fail(new Error("operator confirmation pending"))}} as any
 await Effect.runPromise(W.Plugin.effect({tool:{transform:(fn:any)=>Effect.sync(()=>fn({add:(value:any)=>tool=value}))}} as any).pipe(Effect.provideService(O.Service,orchestra),Effect.provideService(F.Service,federation),Effect.provideService(P.Service,permission)))
 const context={sessionID:"ses_a",agent:"orchestrator",messageID:"msg",id:"call"} as any
 const list=await Effect.runPromise(tool.execute({action:"list"},context))
 expect(JSON.stringify(list)).toContain("Same society")
 for(const hidden of ["FOREIGN","/private","ses_secret","Foreign society","ses_soc_secret","ses_b","ses_soc_a"])expect(JSON.stringify(list)).not.toContain(hidden)
 const result=await Effect.runPromise(Effect.exit(tool.execute({action:"create_group",name:"new group",mode:"council",link:false,members:[{projectID:"prj_a"},{projectID:"prj_c"}]},context)))
 expect(result._tag).toBe("Failure")
 expect(checks).toHaveLength(1)
 expect(checks[0].resources).toEqual(["create_group:new group:project:prj_c"])
 expect(checks[0].save).toEqual([])
})
