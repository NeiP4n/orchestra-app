import {createSignal} from "solid-js"
import {DialogPrompt} from "../ui/dialog-prompt"
import {useDialog} from "../ui/dialog"
import {useTheme} from "../context/theme"
import {ScheduleView} from "@orchestra/core/schedule-view"
import {parseScheduleLimit} from "../util/schedule-limit"
/** The sidebar and its numeric prompt use the same exact owner/trigger request path. */
export function ScheduleLimitDialog(props:{item:ScheduleView.Item;sessionID:string;day?:boolean;onSaved?:()=>void}){
 const dialog=useDialog(),theme=useTheme(),[error,setError]=createSignal("")
 const current=()=>props.day?ScheduleView.dailyLimitRequested(props.item.id,props.sessionID)?.maxPerDay??props.item.maxPerDay??48:(ScheduleView.hourlyLimitRequested(props.item.id,props.sessionID)??{maxPerHour:props.item.maxPerHour===null?null:props.item.maxPerHour??6}).maxPerHour
 return <DialogPrompt title={props.day?"Суточный лимит этого триггера":"Часовой лимит этого триггера"} value={current()===null?"без лимита":String(current())}
 description={()=><text fg={theme.text.muted} wrapMode="word">{error()||`${props.day?"Число 1-100 в сутки":"Число 1-10000 или без лимита в час"}. Введите число и Enter, без слов и дополнительного подтверждения. Только ${props.item.name} (${props.item.id}). Запрос сохраняется сразу; сервис применит его на следующей проверке. История и остальные лимиты сохраняются.`}</text>}
 onConfirm={value=>{const limit=parseScheduleLimit(value,props.day);if(limit===undefined){setError(props.day?"Введите число 1-100.":"Введите число 1-10000 или без лимита.");return}try{if(props.day)ScheduleView.requestDailyLimit(props.item.id,props.sessionID,limit!);else ScheduleView.requestHourlyLimit(props.item.id,props.sessionID,limit);props.onSaved?.();dialog.clear()}catch{setError("Лимит не сохранён. Проверьте владельца и существование триггера.")}}} onCancel={()=>dialog.clear()}/>
}
