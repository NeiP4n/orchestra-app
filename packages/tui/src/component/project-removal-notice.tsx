import { useTheme } from "../context/theme"
import { useT } from "../util/i18n"
export function ProjectRemovalNotice() {
  const theme = useTheme(), t = useT()
  return <text fg={theme.text.muted} wrapMode="word">{t("Removes this project and its owned chats from Orchestra. Files in the project folder, .orchestra data and exported templates are kept.")}</text>
}
