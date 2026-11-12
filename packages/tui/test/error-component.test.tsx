/** @jsxImportSource @opentui/solid */
import {expect,test} from "bun:test"
import {testRender} from "@opentui/solid"
import {ErrorComponent,errorTheme} from "../src/component/error-component"
import {ExitProvider} from "../src/context/exit"
import {TestTuiContexts} from "./fixture/tui-environment"
test("error fallback survives absent or partial theme and hovered crash controls",async()=>{
 expect(errorTheme(undefined).background.action.primary.focused).toBeDefined()
 expect(errorTheme({text:{muted:"#cccccc"}} as never).background.action.primary.focused).toBeDefined()
 let reset=0
 const app=await testRender(()=><TestTuiContexts><ExitProvider exit={()=>{}}><ErrorComponent error={new Error("fixture crash")} reset={()=>reset++}/></ExitProvider></TestTuiContexts>,{width:80,height:24})
 try{
  await app.renderOnce();expect(app.captureCharFrame()).toContain("Orchestra crashed")
  const lines=app.captureCharFrame().split("\n"),y=lines.findIndex(l=>l.includes("Restart")),x=lines[y]!.indexOf("Restart")
  await app.mockMouse.moveTo(x,y);await app.renderOnce();expect(app.captureCharFrame()).toContain("Copy report")
  await app.mockMouse.click(x,y);await app.renderOnce();expect(reset).toBe(1)
  await Bun.write("/tmp/error-fallback-fixed.json",JSON.stringify(app.captureSpans()))
 }finally{app.renderer.destroy()}
})
