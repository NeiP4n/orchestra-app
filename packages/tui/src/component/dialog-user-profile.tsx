import { createSignal } from "solid-js"
import { useConfig } from "../config"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { profileFields, profileValue } from "../util/user-profile"
import { UserNameEdit } from "./user-name-bar"
export function DialogUserProfile(){
  const config=useConfig(),dialog=useDialog(),theme=useTheme(),toast=useToast()
  const [selected,setSelected]=createSignal("name")
  const rows=()=>[{title:"Имя пользователя",value:"name",footer:config.data.user_name??"vibecoder"},...profileFields.map(field=>({title:field.title,value:field.key,footer:config.data.user_profile?.[field.key]?"задано · открыть":"не задано"})),{title:"Очистить профиль",value:"clear",footer:"имя → vibecoder"}]
  const reopen=()=>dialog.replace(()=><DialogUserProfile />)
  return <DialogSelect title="Профиль пользователя" options={rows()} onMove={o=>setSelected(o.value)} onSelect={o=>{
    if(o.value==="name")return dialog.replace(()=><UserNameEdit />)
    if(o.value==="clear")return dialog.replace(()=><DialogPrompt title="Очистить профиль?" placeholder="Введите ОЧИСТИТЬ" description={()=><text fg={theme.text.muted}>Удалит обращение, манеру, язык и стиль. Имя станет vibecoder. Прошлые запросы модели и их история не удаляются.</text>} onConfirm={answer=>{if(answer.trim()!=="ОЧИСТИТЬ")return;void config.update(d=>{delete d.user_profile;delete d.user_name}).then(reopen).catch(toast.error)}} onCancel={reopen}/>)
    const field=profileFields.find(field=>field.key===o.value);if(!field)return
    dialog.replace(()=><DialogPrompt title={field.title} value={config.data.user_profile?.[field.key]??""} description={()=><text fg={theme.text.muted}>{field.description} До240символов. Без паролей, токенов и ключей. Пустое значение удаляет поле.</text>} onConfirm={answer=>{let value:string;try{value=profileValue(answer)}catch(error){toast.error(error);return}void config.update(d=>{d.user_profile??={};if(value)d.user_profile[field.key]=value;else delete d.user_profile[field.key]}).then(reopen).catch(toast.error)}} onCancel={reopen}/>)
  }} footer={<text fg={theme.text.muted} wrapMode="word">{profileFields.find(f=>f.key===selected())?.description??"Профиль полностью виден и правится только вами через этот экран."} {profileFields.some(f=>f.key===selected()) ? `Сейчас: ${config.data.user_profile?.[selected() as keyof NonNullable<typeof config.data.user_profile>] || "не задано"}.` : ""} Хранится локально, передаётся выбранной модели. Не храните секреты. Фильтр ловит только очевидные ключи. Очистка не удаляет прошлую историю.</text>}/>
}
