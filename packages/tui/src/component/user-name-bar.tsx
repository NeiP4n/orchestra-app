import { useConfig } from "../config"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { HoverAction } from "./hover-action"
import { userName, displayUserName } from "../util/user-name"
export function UserNameEdit() {
  const config=useConfig(), dialog=useDialog(), toast=useToast()
  return <DialogPrompt title="Как к вам обращаться" value={displayUserName(config.data.user_name)} placeholder="vibecoder" onConfirm={(value)=>{
    let name:string
    try { name=userName(value) } catch(error) { toast.error(error); return }
    void config.update((draft)=>{draft.user_name=name}).then(()=>dialog.clear()).catch(toast.error)
  }} onCancel={()=>dialog.clear()} />
}
export function UserNameBar() {
  const config=useConfig(), dialog=useDialog(), theme=useTheme()
  return <box width="100%" flexDirection="row" justifyContent="center" flexShrink={0} minHeight={1}>
    <HoverAction onClick={()=>dialog.replace(()=><UserNameEdit />)}><text fg={theme.text.base} wrapMode="word">{displayUserName(config.data.user_name)}</text></HoverAction>
  </box>
}
