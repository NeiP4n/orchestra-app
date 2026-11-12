/** @jsxImportSource @opentui/solid */
import {expect,mock} from "bun:test"
import {testRender} from "@opentui/solid"
import {mkdtempSync,rmSync} from "node:fs"
import os from "node:os"
import path from "node:path"
import {ScheduleView} from "@orchestra/core/schedule-view"
import {Trigger} from "@orchestra/core/trigger"
let prompt:any,closed=0
mock.module("../../src/ui/dialog-prompt",()=>({DialogPrompt:(props:any)=>{prompt=props;return <box><text>{props.title}</text>{props.description()}</box>}}))
mock.module("../../src/ui/dialog",()=>({useDialog:()=>({clear(){closed++}})}))
mock.module("../../src/context/theme",()=>({useTheme:()=>({text:{muted:"#cccccc"}})}))
const {ScheduleLimitDialog}=await import("../../src/component/schedule-limit-dialog")
async function check(){
 const root=mkdtempSync(path.join(os.tmpdir(),"sidebar-limit-")),prior=process.env.ORCHESTRA_DATA_DIR;process.env.ORCHESTRA_DATA_DIR=root
 const made=Trigger.create({kind:"interval",spec:"60",prompt:"Fixture"},{id:"trigger_a",projectID:"project_a",now:1000,existing:0});if(!made.ok)throw Error(made.error)
 ScheduleView.sync({...made.trigger,maxPerHour:12},"main_a");ScheduleView.sync({...made.trigger,id:"trigger_b",maxPerHour:6},"main_b")
 let app=await testRender(()=><ScheduleLimitDialog item={ScheduleView.list("main_a")[0]!} sessionID="main_a"/>,{width:100,height:12})
 try{
  await app.renderOnce();prompt.onConfirm("100");expect(ScheduleView.hourlyLimitRequested("trigger_a","main_a")).toEqual({maxPerHour:100});expect(closed).toBe(1)
  prompt.onConfirm("РАЗРЕШИТЬ");expect(closed).toBe(1);prompt.onConfirm("100");expect(closed).toBe(2)
  prompt.onConfirm("РАЗРЕШИТЬ 100");expect(ScheduleView.hourlyLimitRequested("trigger_a","main_a")?.maxPerHour).toBe(100)
  expect(ScheduleView.hourlyLimitRequested("trigger_b","main_b")).toBeUndefined();expect(ScheduleView.hourlyLimitRequested("trigger_a","main_b")).toBeUndefined()
  const child=Bun.spawnSync([process.execPath,"-e",`import {ScheduleView} from ${JSON.stringify(import.meta.resolve("@orchestra/core/schedule-view"))};if(ScheduleView.hourlyLimitRequested('trigger_a','main_a')?.maxPerHour!==100)process.exit(2);console.log('persisted')`],{env:process.env})
  expect(child.exitCode).toBe(0);expect(child.stdout.toString()).toContain("persisted")
  app.renderer.destroy();app=await testRender(()=><ScheduleLimitDialog item={ScheduleView.list("main_a")[0]!} sessionID="main_a" day/>,{width:100,height:12});await app.renderOnce();prompt.onConfirm("100");expect(ScheduleView.dailyLimitRequested("trigger_a","main_a")?.maxPerDay).toBe(100);prompt.onConfirm("101");expect(ScheduleView.dailyLimitRequested("trigger_a","main_a")?.maxPerDay).toBe(100)
 }finally{app.renderer.destroy();if(prior===undefined)delete process.env.ORCHESTRA_DATA_DIR;else process.env.ORCHESTRA_DATA_DIR=prior;rmSync(root,{recursive:true,force:true})}
}
await check()
console.log("schedule dialog assertions passed")

