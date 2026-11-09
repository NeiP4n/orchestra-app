import { createSignal } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { useConfig } from "../config"
import { securitySettings } from "../util/security-settings"
export function DialogSecurity(){
  const theme=useTheme(),config=useConfig(),entries=securitySettings()
  const [selected,setSelected]=createSignal(entries[0])
  return <DialogSelect title="Безопасность · реальные механизмы" options={entries.map(entry=>({title:entry.title,value:entry.id,footer:entry.id==="scope"?"сведения":"читать"}))} onMove={option=>setSelected(entries.find(entry=>entry.id===option.value)??entries[0])}
    footer={<box flexDirection="column" minWidth={0}>
      <text fg={theme.text.base} wrapMode="word">{selected()?.title}: {selected()?.value}</text>
      <text fg={theme.text.muted} wrapMode="word">{selected()?.description}</text>
      <text fg={theme.text.muted} wrapMode="word">{`Разрешения этого TUI: ${config.data.session?.permissions==="autoaccept"?"принимать сами · расширено":"спрашивать"}. Меняются в Настройки → Безопасность → Разрешения. Диагностика выше только для чтения, не выдаёт новые права.`}</text>
    </box>}/>
}
