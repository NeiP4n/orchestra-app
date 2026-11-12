/** @jsxImportSource @opentui/solid */
import {expect,test} from "bun:test"
import {DialogIntegration,methodUnavailable} from "../src/component/dialog-integration"
import {renderLocal} from "./fixture/local"
import {directory,json} from "./fixture/tui-client"
for(const language of ["en","ru"] as const)test(`unconfigured Antigravity is visible but never starts OAuth in ${language}`,async()=>{
 let connects=0
 await using app=await renderLocal({language,fetch:async(url,request)=>{
  if(url.pathname.includes("/oauth/")){connects++;return json({})}
  if(url.pathname==="/api/integration")return json({location:{directory},data:[{id:"google-antigravity",name:"Google Antigravity",methods:[{type:"oauth",id:"oauth",label:"Google Antigravity",unavailableReason:"antigravity-client-secret"}],connections:[]}]})
 }})
 app.dialog.replace(()=><DialogIntegration integrationID="google-antigravity" autoConnect />)
 await app.waitForFrame(f=>f.includes("ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET"))
 expect(app.captureCharFrame()).toContain(language==="ru"?"Не настроено":"Not configured")
 await app.mockInput.pressKey("RETURN");await app.renderOnce();expect(connects).toBe(0)
 if(language==="ru")await Bun.write("/tmp/antigravity-setup.json",JSON.stringify(app.captureSpans()))
})
test("only explicitly unavailable OAuth is blocked, not Google API key or a configured OAuth",()=>{
 expect(methodUnavailable({type:"oauth",id:"oauth",label:"Sign in"} as never)).toBe(false)
 expect(methodUnavailable({type:"key"} as never)).toBe(false)
 expect(methodUnavailable({type:"oauth",id:"oauth",label:"Sign in",unavailableReason:"antigravity-client-secret"} as never)).toBe(true)
})
