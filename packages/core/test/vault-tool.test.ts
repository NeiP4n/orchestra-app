import {test,expect,mock} from "bun:test"
import {Context,Effect,Schema} from "effect"
class Sessions extends Context.Service<Sessions,any>()("vault-test/Sessions"){}
class Failure extends Schema.TaggedError<Failure>()("ToolFailure",{message:Schema.String}){}
mock.module("../src/session.js",()=>({Session:{Service:Sessions}}))
mock.module("@orchestra/ai",()=>({ToolFailure:Failure}))
const calls:unknown[]=[]
mock.module("../src/credential-vault/index.js",()=>({CredentialVault:{local:(projectID:string)=>({list:async()=>{calls.push(projectID);return [{id:"entry",name:"API"}]},writeFromOperator:async()=>{throw Error("native error secret fake-SECRET")},checkHttp:async()=>({status:200,durationMs:1,body:"fake-SECRET"})})}}))
const {VaultTool}=await import("../src/tool/plugin/vault")
test("actual Vault tool returns names only and fixed errors, never request errors or raw output; guide attached to every session",async()=>{
 let tool:any,hook:any,projectID:string|undefined="prj_a"
 const run=(v:any)=>Effect.runPromise(v.pipe(Effect.provideService(Sessions,{get:()=>Effect.succeed({location:{directory:"/project"},metadata:projectID?{"orchestra:project-owner":{projectID}}:{}})})))
 await run(VaultTool.Plugin.effect({session:{hook:(_name:string,fn:any)=>Effect.sync(()=>hook=fn)},tool:{transform:(fn:any)=>Effect.sync(()=>fn({add:(v:any)=>tool=v}))}} as any))
 const ctx={sessionID:"ses_a"},execute=(input:any)=>run(tool.execute(input,ctx))
 const output=await execute({action:"list"});expect(output.content).toContain('"name":"API"');expect(output.content).not.toContain("blob");expect(calls).toEqual(["prj_a"])
 for(const input of [{action:"request",name:"new",site:"https://example.invalid/v1"},{action:"check_http",name:"API",url:"https://example.invalid/v1/models"}]){try{await execute(input);throw Error("must reject")}catch(error){expect(String(error)).not.toContain("fake-SECRET");expect(String(error)).toContain("Vault action failed")}}
 const event={system:[] as any[]};await run(hook(event));expect(event.system[0].text).toContain("NEVER be requested in chat");expect(event.system[0].text).toContain(".env");expect(event.system[0].text).toContain("masked native operator form")
 projectID=undefined;await expect(execute({action:"list"})).rejects.toThrow("verified project")
 expect(tool.description).not.toContain("fake-SECRET")
})
