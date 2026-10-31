import { useOptionalConfig } from "../config"
import { useT } from "./i18n"

// Labels used by the project-group dialog that are not part of the shared
// upstream locale table yet. Keep them here temporarily, but only activate
// them for Russian so the English locale is never accidentally changed.
const ru: Record<string, string> = {
  "New Society": "Новое Общество",
  "Goal": "Цель",
  "Folder": "Папка",
  "optional, default ~/orchestra-society": "по желанию, по умолчанию ~/orchestra-society",
  "e.g. release a mobile fishing game": "например: выпустить мобильную игру про рыбалку",
  "Start Society": "Запустить общество",
  "Describe the goal.": "Опиши цель.",
  "Write the goal once. The Society creates itself, decides which projects it needs, creates them with their teams, links them through federation and starts them, all in one folder.": "Напиши цель один раз. Общество создаст себя само, решит, какие проекты нужны, создаст их с командами, свяжет через федерацию и запустит, всё в одной папке.",
  Edit: "Изменить",
  Delete: "Удалить",
  "Delete?": "Удалить?",
  "Creating...": "Создаётся...",
}

export function useGroupT() {
  const base = useT()
  const config = useOptionalConfig()
  return (text: string, values?: Record<string, string | number>) => {
    const translated = base(text, values)
    if (translated !== text) return translated
    if (config?.data.language !== "ru") return text
    const value = ru[text]
    if (!value) return text
    return value.replace(/\{(\w+)\}/g, (match, key: string) => {
      if (!values || !(key in values)) return match
      return String(values[key])
    })
  }
}
