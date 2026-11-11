import { createMemo, createSignal, onCleanup } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { useConfig } from "../config"
import { securitySettings } from "../util/security-settings"
import { steppedLimit, parseSecurityNumber } from "../util/security-change"
import { pendingApprovals, removeApproval } from "../util/security-confirmation"
import { useProjects } from "../context/projects"
import { useData } from "../context/data"
import { Orchestra } from "@orchestra/schema/orchestra"
import { ConsoleAccess } from "@orchestra/core/console-access"
import { VaultAccess } from "@orchestra/core/credential-vault/access"
import { SafetyConfig } from "@orchestra/core/safety-config"
import { Limits } from "@orchestra/core/limits"
import { ScheduleView } from "@orchestra/core/schedule-view"

type Row = { id: string; title: string; value: string; description: string; editable?: boolean; environment?: boolean; item?: ScheduleView.Item; day?: boolean; console?:ConsoleAccess.Scope; vault?:VaultAccess.Scope; safety?: "all"|"drainMs"|"drainTokens"|"browserMax"|"localTest" }
const environment = new Set(["limits", "wall", "tokens", "browsers"])
export function DialogSecurity(props: { current?: string } = {}) {
  const theme=useTheme(), config=useConfig(), projects=useProjects(), data=useData(), route=useRoute(), toast=useToast()
  const sessionID = () => route.data.type === "session" ? route.data.sessionID : undefined
  const [tick,setTick]=createSignal(0), [selected,setSelected]=createSignal(props.current ?? "scope"), [busy,setBusy]=createSignal(false), [digits,setDigits]=createSignal("")
  const timer=setInterval(()=>setTick(n=>n+1),2000);onCleanup(()=>clearInterval(timer))
  const entries=createMemo<Row[]>(()=>{
    tick()
    const base: Row[]=securitySettings().filter(e=>!["triggers","trigger-day","limits","wall","tokens","browsers","ORCHESTRA_DISABLE_LIMITS","ORCHESTRA_ENFORCE_LIMITS","ORCHESTRA_BROWSER_LOCAL_TEST","ORCHESTRA_BROWSER_LIMIT"].includes(e.id)).map(e=>({...e,environment:environment.has(e.id)||e.id.startsWith("ORCHESTRA_")}))
    const safety=SafetyConfig.read(),env=process.env
    const envNote=(name:string)=>env[name]===undefined?"конфиг, сервис читает на следующей проверке":`${name} задано окружением и переопределяет конфиг`
    base.splice(1,0,
      {id:"safety-all",title:"Защита лимитов: время/токены/шаги/циклы",value:Limits.fullyDisabled()?"ВЫКЛЮЧЕНА · расширено":"включена",description:`← включить, сохранив числовые лимиты, → полностью выключить сразу. Деньги/Vault/публикация не входят. Повторные попытки/verify/hops сервиса и MCP30мин перестают ограничивать на следующем решении/новом вызове. Уже запущенный timeout не пересоздаётся. JS timer имеет технический предел24.8дня. ${envNote("ORCHESTRA_ENFORCE_LIMITS")}. Старые OFF env сами не выключают защиту. Другие data/state директории и удалённый сервис не меняются.`,editable:true,safety:"all"},
      {id:"safety-wall",title:"Время одного drain (мин)",value:Limits.drainWallClockMs()===undefined?"без лимита · расширено":String(Limits.drainWallClockMs()!/60000)+(Limits.drainWallClockMs()!>14400000?" · расширено":""),description:`Шаг15мин, минимум1мин. ${envNote("ORCHESTRA_DRAIN_WALL_CLOCK_MS")}. Уже идущий drain сверяет budget повторно.`,editable:true,safety:"drainMs"},
      {id:"safety-tokens",title:"Токены одного drain",value:String(Limits.drainTokenBudget()??"без лимита · расширено")+((Limits.drainTokenBudget()??0)>10000000?" · расширено":""),description:`Шаг100000, минимум1000. ${envNote("ORCHESTRA_DRAIN_TOKEN_BUDGET")}.`,editable:true,safety:"drainTokens"},
      {id:"safety-browsers",title:"Активные профили браузера",value:env.ORCHESTRA_BROWSER_LIMIT==="off"?"без лимита · ENV":env.ORCHESTRA_BROWSER_MAX??String(safety.browserMax??"без лимита · расширено"),description:`← уменьшить (unlimited→6), → увеличить (100→unlimited). Уже открытые браузеры не закрываются. ${envNote("ORCHESTRA_BROWSER_MAX")}; ${envNote("ORCHESTRA_BROWSER_LIMIT")}. PID/CDP/один профиль/launch lock не отключаются.`,editable:true,safety:"browserMax"},
      {id:"safety-local",title:"Локальный fixture-test браузера",value:(env.ORCHESTRA_BROWSER_LOCAL_TEST===undefined?safety.localTest===true:env.ORCHESTRA_BROWSER_LOCAL_TEST==="1")?"включён · расширено":"выключен",description:`← выключить, → включить сразу. Только loopback/file; remote URL по-прежнему запрещён. ${envNote("ORCHESTRA_BROWSER_LOCAL_TEST")}.`,editable:true,safety:"localTest"})
    base.splice(1,0,{id:"permissions",title:"Разрешения сессий",value:config.data.session?.permissions==="autoaccept"?"принимать сами · расширено":"спрашивать",description:"Настройка этого TUI. Автоподтверждение команд и изменений файлов не разрешает оплату, секреты или публикацию.",editable:true})
    const owner=sessionID()
    const projectID=owner?(projects.owner(owner)??Orchestra.sessionOwner(data.session.get(owner)?.metadata)):undefined
    const info=owner?data.session.get(owner):undefined
    if(owner&&projectID&&info){const scope={sessionID:owner,projectID,directory:info.location.directory};base.unshift({id:"vault-http",title:"Vault: подстановка HTTP",value:VaultAccess.current(scope)?"ВКЛ · расширено":"OFF",description:"← OFF, → ВКЛ сразу на 1 час, только этот чат/проект. Secret по имени в fixed HTTPS GET/Bearer только savedBase/models; raw body/headers скрыты, redirects запрещены. Произвольная shell/env инъекция отсутствует. DPAPI Windows, другие ОС fail closed. Деньги/публикация не разрешены.",editable:true,vault:scope})}
    const terminal=owner?ConsoleAccess.selected(owner):undefined
    if(terminal){const mode=ConsoleAccess.current(terminal).mode;base.unshift({id:"console-mode",title:"ИИ во встроенной консоли",value:mode+(mode!=="off"?" · расширено":""),description:"Только консоль текущего чата и проекта. ←/→: OFF, чтение, подтверждение, полный ввод. Сразу на 1 час. Полный ввод разрешает команды. Отозвать можно над консолью. Vault не подключён; обычный shell/bash отдельно.",editable:true,console:terminal})}
    const triggers=owner?ScheduleView.list(owner):[]
    if(!triggers.length)base.push({id:"trigger-empty",title:"Лимиты расписаний",value:"откройте главный чат с триггерами",description:"Индивидуальные лимиты показываются только для триггеров текущего главного чата. Чужой триггер не выбирается автоматически."})
    for(const item of triggers)for(const day of [false,true]){
      const pending=day?ScheduleView.dailyLimitRequested(item.id,owner!):ScheduleView.hourlyLimitRequested(item.id,owner!)
      const cap=day?item.maxPerDay??48:item.maxPerHour===null?null:item.maxPerHour??6
      base.push({id:`${day?"day":"hour"}:${item.id}`,title:`${item.name} · ${day?"сутки":"час"}`,value:`${cap===null?"без лимита":cap}${cap===null||cap>(day?48:6)?" · расширено":""}${pending?` · запрос ${day?(pending as {maxPerDay:number}).maxPerDay:(pending as {maxPerHour:number|null}).maxPerHour??"без лимита"}`:""}`,description:`${item.id}. Только этот триггер. История и прочие ограничения сохраняются. ${day?"1-100 в сутки, без unlimited. Изменение не снимает паузу.":"1-10000 в час или без лимита."} ← уменьшить, → увеличить. Новый лимит применит сервис; до этого показано фактическое последнее значение.`,editable:true,item,day})
    }
    return base
  })
  const row=()=>entries().find(e=>e.id===selected())??entries()[0]
  // Old review requests never auto-apply after the operator changed the UI policy.
  for(const request of pendingApprovals())removeApproval(request.id)
  function apply(run:()=>unknown){
    if(busy())return
    try{const result=run();setTick(n=>n+1);if(result instanceof Promise){setBusy(true);result.catch(toast.error).finally(()=>{setBusy(false);setTick(n=>n+1)})}}
    catch(error){toast.error(error)}
  }
  function numberValue(value:string){
    const entry=row();if(!entry?.editable)return
    const max=entry.item?(entry.day?100:10000):Number.MAX_SAFE_INTEGER
    const parsed=parseSecurityNumber(value,max);if(parsed===undefined)return
    if(entry.safety && !["all","localTest"].includes(entry.safety)){
      const multiplier=entry.safety==="drainMs"?60000:1
      if(!Number.isSafeInteger(parsed*multiplier))return
      return apply(()=>SafetyConfig.write({...SafetyConfig.read(),[entry.safety!]:parsed*multiplier}))
    }
    const owner=sessionID();if(!entry.item||!owner)return
    apply(()=>entry.day?ScheduleView.requestDailyLimit(entry.item!.id,owner,parsed):ScheduleView.requestHourlyLimit(entry.item!.id,owner,parsed))
  }
  function inputDigit(digit:string){const entry=row();if(!entry?.item&&!(["drainMs","drainTokens","browserMax"].includes(entry?.safety??"")))return;const value=(digits()+digit).slice(0,16);setDigits(value);numberValue(value)}
  function change(direction:-1|1,fast=1){
    if(busy())return
    setDigits("")
    const entry=row();if(!entry?.editable)return
    if(entry.console){const modes:ConsoleAccess.Mode[]=["off","read","confirm","full"],index=modes.indexOf(ConsoleAccess.current(entry.console).mode);return apply(()=>ConsoleAccess.set(entry.console!,modes[Math.max(0,Math.min(3,index+direction))]!))}
    if(entry.vault)return apply(()=>VaultAccess.set(entry.vault!,direction>0))
    if(entry.safety){
      const before=SafetyConfig.read(),next={...before}
      if(entry.safety==="all"){
        if(direction<0)return apply(()=>SafetyConfig.restore())
        next.disabled=true
      }else if(entry.safety==="localTest"){next.localTest=direction>0}
      else if(entry.safety==="browserMax"){
        const cap=before.browserMax??null
        const value=cap===null?direction<0?6:null:direction>0&&cap===100&&fast===1?null:Math.max(1,cap+direction*fast)
        next.browserMax=value
      }else{
        const key=entry.safety,step=key==="drainMs"?900000:100000,floor=key==="drainMs"?60000:1000,cap=before[key]??(key==="drainMs"?14400000:10000000)
        next[key]=Math.max(floor,cap+direction*step*fast)
      }
      if(JSON.stringify(next)===JSON.stringify(before))return
      return apply(()=>SafetyConfig.write(next))
    }
    if(entry.id==="permissions"){
      const next=direction<0?"prompt":"autoaccept"
      if((config.data.session?.permissions??"prompt")===next)return
      return apply(()=>config.update(d=>{d.session??={};d.session.permissions=next}))
    }
    const item=entry.item,owner=sessionID();if(!item||!owner)return
    const pending=ScheduleView.hourlyLimitRequested(item.id,owner)
    const current=entry.day?ScheduleView.dailyLimitRequested(item.id,owner)?.maxPerDay??item.maxPerDay??48:pending?pending.maxPerHour:(item.maxPerHour===null?null:item.maxPerHour??6)
    const next=steppedLimit(current,direction,entry.day,fast);if(next===current)return
    apply(()=>entry.day?ScheduleView.requestDailyLimit(item.id,owner,next!):ScheduleView.requestHourlyLimit(item.id,owner,next))
  }
  return <DialogSelect title="Безопасность · реальные механизмы" current={selected()} options={entries().map(entry=>({title:entry.title,value:entry.id,footer:entry.editable?`← ${entry.value} →`:entry.environment?"задано окружением":["js","money"].includes(entry.id)?"такой защиты нет":"нет переключателя, описание"}))} onMove={option=>{if(selected()!==option.value){setSelected(option.value);setDigits("")}}} bindings={[{bind:"left",title:"Уменьшить / спрашивать",group:"Безопасность",run:()=>change(-1)},{bind:"right",title:"Увеличить / авто",group:"Безопасность",run:()=>change(1)},...(["shift+left","shift+right","pageup","pagedown"] as const).map(bind=>({bind,title:"Быстрый шаг ×100",group:"Безопасность",run:()=>change(bind==="shift+left"||bind==="pagedown"?-1:1,100)})),...Array.from({length:10},(_,i)=>({bind:String(i),title:"Ввести цифру",group:"Безопасность",run:()=>inputDigit(String(i))})),{bind:"backspace",title:"Удалить цифру",group:"Безопасность",run:()=>{const value=digits().slice(0,-1);setDigits(value);numberValue(value)}},{bind:"enter",title:"Завершить ввод",group:"Безопасность",run:()=>setDigits("")}]}
    footer={<box flexDirection="column" minWidth={0}>
      <text fg={theme.text.base} wrapMode="word">{row()?.title}: {row()?.value}</text>
      <text fg={theme.text.muted} wrapMode="word">{row()?.description}</text>
      <text fg={theme.text.base}>Ввод: {digits()||"-"} (применяется сразу, допустимые значения указаны выше)</text>
      <text fg={theme.text.muted} wrapMode="word">{row()?.editable?"←/→ сразу · Shift+стрелка / PgUp/PgDn: ×100 · цифры: заменить число · Enter: закончить. Случайная стрелка тоже меняет защиту.":row()?.environment?"Задаётся окружением процесса сервиса; стрелки здесь не меняют env и не изображают изменение.":"Нет переключателя, только описание реального механизма или отсутствующей защиты."}</text>
    </box>}/>
}
