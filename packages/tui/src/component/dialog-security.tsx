import { createMemo, createSignal, onCleanup } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { useConfig } from "../config"
import { securitySettings } from "../util/security-settings"
import { limitExpansion, steppedLimit } from "../util/security-change"
import { ScheduleView } from "@orchestra/core/schedule-view"

type Row = { id: string; title: string; value: string; description: string; editable?: boolean; environment?: boolean; item?: ScheduleView.Item; day?: boolean }
const environment = new Set(["limits", "wall", "tokens", "browsers"])
export function DialogSecurity(props: { current?: string } = {}) {
  const theme=useTheme(), config=useConfig(), dialog=useDialog(), route=useRoute(), toast=useToast()
  const sessionID = () => route.data.type === "session" ? route.data.sessionID : undefined
  const [tick,setTick]=createSignal(0), [selected,setSelected]=createSignal(props.current ?? "scope"), [busy,setBusy]=createSignal(false)
  const timer=setInterval(()=>setTick(n=>n+1),2000);onCleanup(()=>clearInterval(timer))
  const entries=createMemo<Row[]>(()=>{
    tick()
    const base: Row[]=securitySettings().filter(e=>!["triggers","trigger-day"].includes(e.id)).map(e=>({...e,environment:environment.has(e.id)||e.id.startsWith("ORCHESTRA_")}))
    base.splice(1,0,{id:"permissions",title:"Разрешения сессий",value:config.data.session?.permissions==="autoaccept"?"принимать сами · расширено":"спрашивать",description:"Настройка этого TUI. Автоподтверждение команд и изменений файлов не разрешает оплату, секреты или публикацию.",editable:true})
    const owner=sessionID()
    const triggers=owner?ScheduleView.list(owner):[]
    if(!triggers.length)base.push({id:"trigger-empty",title:"Лимиты расписаний",value:"откройте главный чат с триггерами",description:"Индивидуальные лимиты показываются только для триггеров текущего главного чата. Чужой триггер не выбирается автоматически."})
    for(const item of triggers)for(const day of [false,true]){
      const pending=day?ScheduleView.dailyLimitRequested(item.id,owner!):ScheduleView.hourlyLimitRequested(item.id,owner!)
      const cap=day?item.maxPerDay??48:item.maxPerHour===null?null:item.maxPerHour??6
      base.push({id:`${day?"day":"hour"}:${item.id}`,title:`${item.name} · ${day?"сутки":"час"}`,value:`${cap===null?"без лимита":cap}${cap===null||cap>(day?48:6)?" · расширено":""}${pending?" · ожидает применения":""}`,description:`${item.id}. Только этот триггер. История и прочие ограничения сохраняются. ${day?"1-100 в сутки, без unlimited. Изменение не снимает паузу.":"1-10000 в час или без лимита."} ← уменьшить, → увеличить. Новый лимит применит сервис; до этого показано фактическое последнее значение.`,editable:true,item,day})
    }
    return base
  })
  const row=()=>entries().find(e=>e.id===selected())??entries()[0]
  const reopen=()=>dialog.replace(()=><DialogSecurity current={selected()}/>)
  function apply(run:()=>void|Promise<unknown>,expansion:boolean,description:string){
    const commit=()=>{setBusy(true);Promise.resolve().then(run).then(()=>{setTick(n=>n+1);reopen()}).catch(toast.error).finally(()=>setBusy(false))}
    if(!expansion)return commit()
    dialog.replace(()=><DialogPrompt title="Расширить ограничение?" placeholder="Введите РАЗРЕШИТЬ" description={()=><text fg={theme.text.muted} wrapMode="word">{description} Это расширение. Для применения введите РАЗРЕШИТЬ.</text>} onConfirm={answer=>{if(answer.trim()==="РАЗРЕШИТЬ")commit()}} onCancel={reopen}/>)
  }
  function change(direction:-1|1){
    if(busy())return
    const entry=row();if(!entry?.editable)return
    if(entry.id==="permissions"){
      const next=direction<0?"prompt":"autoaccept"
      if((config.data.session?.permissions??"prompt")===next)return
      return apply(()=>config.update(d=>{d.session??={};d.session.permissions=next}),next==="autoaccept",`Разрешения этого TUI: ${next==="autoaccept"?"автоматически подтверждать":"спрашивать"}.`)
    }
    const item=entry.item,owner=sessionID();if(!item||!owner)return
    if(ScheduleView.hourlyLimitRequested(item.id,owner)||ScheduleView.dailyLimitRequested(item.id,owner)){toast.error(new Error("Предыдущее изменение ещё не применено сервисом."));return}
    const current=entry.day?item.maxPerDay??48:item.maxPerHour===null?null:item.maxPerHour??6
    const next=steppedLimit(current,direction,entry.day);if(next===current)return
    apply(()=>entry.day?ScheduleView.requestDailyLimit(item.id,owner,next!):ScheduleView.requestHourlyLimit(item.id,owner,next),limitExpansion(current,next),`${item.name} (${item.id}): ${entry.day?"в сутки":"в час"} ${current??"без лимита"} → ${next??"без лимита"}.`)
  }
  return <DialogSelect title="Безопасность · реальные механизмы" current={props.current} options={entries().map(entry=>({title:entry.title,value:entry.id,footer:entry.editable?`← ${entry.value} →`:entry.environment?"задаётся окружением":"сведения"}))} onMove={option=>setSelected(option.value)} bindings={[{bind:"left",title:"Уменьшить / спрашивать",group:"Безопасность",run:()=>change(-1)},{bind:"right",title:"Увеличить / авто",group:"Безопасность",run:()=>change(1)}]}
    footer={<box flexDirection="column" minWidth={0}>
      <text fg={theme.text.base} wrapMode="word">{row()?.title}: {row()?.value}</text>
      <text fg={theme.text.muted} wrapMode="word">{row()?.description}</text>
      <text fg={theme.text.muted} wrapMode="word">{row()?.editable?"← уменьшить · → увеличить. Расширение требует РАЗРЕШИТЬ.":row()?.environment?"Задаётся окружением процесса сервиса; стрелки здесь не меняют env и не изображают изменение.":"Сведения о механизме, не переключатель прав."}</text>
    </box>}/>
}
