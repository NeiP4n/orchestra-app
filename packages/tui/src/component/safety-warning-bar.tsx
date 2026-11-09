import { createSignal, onCleanup, Show } from "solid-js"
import { SafetyConfig } from "@orchestra/core/safety-config"
import { Limits } from "@orchestra/core/limits"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { HoverAction } from "./hover-action"
export function SafetyWarningBar(){
 const theme=useTheme(),toast=useToast(),[tick,setTick]=createSignal(0)
 const timer=setInterval(()=>setTick(n=>n+1),1000);onCleanup(()=>clearInterval(timer))
 const disabled=()=>{tick();return Limits.fullyDisabled()}
 return <Show when={disabled()}><HoverAction onClick={()=>{try{SafetyConfig.restore();setTick(n=>n+1)}catch(error){toast.error(error)}}}><text fg={theme.text.feedback.warning.base} wrapMode="word">⚠ РАСШИРЕНО: защита лимитов ВЫКЛЮЧЕНА (время/токены/шаги/циклы). [ВКЛЮЧИТЬ ЗАЩИТУ] · деньги/Vault не разрешены</text></HoverAction></Show>
}
