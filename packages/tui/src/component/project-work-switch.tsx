import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useT } from "../util/i18n"
import { HoverAction } from "./hover-action"
export function ProjectWorkSwitch(props: {
 project: {id:string;workEnabled?:boolean}
 set: (enabled:boolean)=>Promise<{workEnabled?:boolean}>
 error:(error:unknown)=>void
}) {
 const theme=useTheme(),t=useT(),[busy,setBusy]=createSignal(false)
 const toggle=async()=>{
  if(busy())return
  const desired=props.project.workEnabled===false
  setBusy(true)
  try { const updated=await props.set(desired); if(updated.workEnabled!==desired)throw Error(t("Project work control needs a server update and restart.")) }
  catch(error){props.error(error)}finally{setBusy(false)}
 }
 return <HoverAction id={`project-work:${props.project.id}`} disabled={busy()} onClick={()=>void toggle()}><text fg={props.project.workEnabled===false?theme.text.feedback.warning.base:theme.text.muted} wrapMode="none">{busy()?" ◌ ":props.project.workEnabled===false?` II ${t("AI paused")} `:` ▶ ${t("AI ON")} `}</text></HoverAction>
}
