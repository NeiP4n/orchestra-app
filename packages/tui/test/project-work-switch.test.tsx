/** @jsxImportSource @opentui/solid */
import { expect,test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { ProjectWorkSwitch } from "../src/component/project-work-switch"
import { ContinuationSwitch } from "../src/component/continuation-switch"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
for(const width of [48,80])test(`two project switches are independent at ${width}`,async()=>{
 const writes:string[]=[],errors:unknown[]=[]
 const View=()=>{const[a,setA]=createSignal(true),[b,setB]=createSignal(true);return <box width={width} flexDirection="column"><ContinuationSwitch access={{get:async()=>({enabled:true}),set:async v=>v}}/><box flexDirection="row"><text flexGrow={1}>Test2</text><ProjectWorkSwitch project={{id:"a",workEnabled:a()}} set={async enabled=>{writes.push("a:"+enabled);setA(enabled);return{workEnabled:enabled}}} error={e=>errors.push(e)}/></box><box flexDirection="row"><text flexGrow={1}>Test3</text><ProjectWorkSwitch project={{id:"b",workEnabled:b()}} set={async enabled=>{writes.push("b:"+enabled);setB(enabled);return{workEnabled:enabled}}} error={e=>errors.push(e)}/></box></box>}
 const app=await testRender(()=><TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({language:"ru"})}><ThemeProvider mode="dark" source={emptyThemeSource}><View/></ThemeProvider></ConfigProvider></TestTuiContexts>,{width,height:10})
 app.renderer.start()
 try{
  await app.waitForFrame(f=>f.includes("Все проекты: ВКЛ"))
  const a=app.renderer.root.findDescendantById("project-work:a")!
  await app.mockMouse.click(a.x+1,a.y)
  await app.waitForFrame(f=>f.includes("ИИ ПАУЗА"))
  const f=app.captureCharFrame();expect(f).toContain("ИИ ВКЛ");expect(f).toContain("Все проекты: ВКЛ")
  expect(writes).toEqual(["a:false"]);expect(errors).toEqual([])
  await Bun.write(`/tmp/per-project-pause-${width}.json`,JSON.stringify(app.captureSpans()))
 }finally{app.renderer.destroy()}
})
