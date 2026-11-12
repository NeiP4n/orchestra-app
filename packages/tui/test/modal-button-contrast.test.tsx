/** @jsxImportSource @opentui/solid */
import {expect,test} from "bun:test"
import {RGBA} from "@opentui/core"
import {testRender} from "@opentui/solid"
import {ConfigProvider} from "../src/config"
import {ThemeProvider,useTheme,useThemes} from "../src/context/theme"
import {modalButtonForeground} from "../src/ui/hover"
import {HoverAction} from "../src/component/hover-action"
import {allThemes,parseTheme} from "../src/theme"
import {themeModes} from "@orchestra/theme/tui"
import {contrastRatio} from "../src/theme/system"
import {createTuiResolvedConfig} from "./fixture/tui-runtime"
import {TestTuiContexts} from "./fixture/tui-environment"
import {DialogConfirm} from "../src/ui/dialog-confirm"
import {renderLocal} from "./fixture/local"
// Render the shared modal-button path, including real mouse hover, for every authored style.
test("every modal button variant/state retains rendered contrast across all registered theme modes",async()=>{
 const failures:string[]=[]
 for(const [name,source] of Object.entries(allThemes()))for(const mode of themeModes(parseTheme(source,name))){
  const Row=()=>{expect(useThemes().selected).toBe(name);const theme=useTheme().surface("dialog");return <box backgroundColor={theme.background.base} flexDirection="column">{(["primary","secondary","destructive"] as const).flatMap(variant=>(["base","hovered","focused","selected","pressed","disabled"] as const).map(state=><HoverAction id={`${variant}-${state}`} variant={variant} disabled={state==="disabled"} background={(theme.background.action[variant] as any)[state]}><text fg={modalButtonForeground(theme,variant,state)}>button</text></HoverAction>))}</box>}
  const app=await testRender(()=><TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({theme:{name,mode}})}><ThemeProvider mode={mode} source={{discover:async()=>({})}}><Row/></ThemeProvider></ConfigProvider></TestTuiContexts>,{width:30,height:20})
  try{
   for(const variant of ["primary","secondary","destructive"])for(const state of ["base","hovered","focused","selected","pressed","disabled"]){
    await app.renderOnce();const n=app.renderer.root.findDescendantById(`${variant}-${state}`)!;await app.mockMouse.moveTo(n.x,n.y);await app.renderOnce()
    const span=app.captureSpans().lines[n.y]?.spans.find(s=>s.text.includes("button"))
    if(!span){failures.push(`${name}/${mode}/${variant}/${state}:missing`);continue}
    const rgba=(c:any)=>RGBA.fromInts(c.buffer[0],c.buffer[1],c.buffer[2],c.buffer[3])
    if(contrastRatio(rgba(span.fg),rgba(span.bg)) < (state==="disabled"?3:4.5))failures.push(`${name}/${mode}/${variant}/${state}: ${contrastRatio(rgba(span.fg),rgba(span.bg))} fg=${JSON.stringify(span.fg)} bg=${JSON.stringify(span.bg)}`)
   }
  }finally{app.renderer.destroy()}
 }
 expect(failures).toEqual([])
},30000)
test("clear-all confirmation retains focused text/background when pointer enters",async()=>{
 await using app=await renderLocal({language:"ru"})
 app.dialog.replace(()=><DialogConfirm title="Очистить все сессии" message="Удалить 2 сессии на этой машине, во всех проектах? Текущая сессия тоже будет закрыта. Отменить будет нельзя." label={{confirm:"Удалить все",cancel:"Отмена"}}/>)
 await app.waitForFrame(f=>f.includes("Удалить все"))
 const lines=app.captureCharFrame().split("\n"),y=lines.findIndex(l=>l.includes("Удалить все")),x=lines[y].indexOf("Удалить все")
 await app.mockMouse.moveTo(x,y);await app.renderOnce()
 await Bun.write("/tmp/clear-confirm-contrast.json",JSON.stringify(app.captureSpans()))
 expect(app.captureCharFrame()).toContain("Удалить все")
})
