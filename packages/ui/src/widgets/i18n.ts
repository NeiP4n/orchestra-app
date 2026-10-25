export type WidgetLanguage = "en" | "ru"

let currentLanguage: WidgetLanguage = "en"

export function setWidgetLanguage(language: WidgetLanguage) {
  currentLanguage = language
}

export function getWidgetLanguage(): WidgetLanguage {
  return currentLanguage
}

const ruDict: Record<string, string> = {
  Yes: "Да",
  No: "Нет",
  Apply: "Применить",
  Reject: "Отклонить",
  "Answer to “{title}”: {value}": "Ответ на «{title}»: {value}",
  "Answer: {value}": "Ответ: {value}",
  "{value} of {max}": "{value} из {max}",
  "run `{command}`": "выполни `{command}`",
  nothing: "ничего",
  yes: "да",
  no: "нет",
  choice: "выбор",
  multiple: "множественный выбор",
  confirmation: "подтверждение",
  buttons: "кнопки",
  input: "ввод",
  form: "форма",
  scale: "шкала",
  table: "таблица",
  progress: "прогресс",
  steps: "шаги",
  changes: "изменения",
  code: "код",
  summary: "сводка",
  note: "заметка",
  tabs: "вкладки",
  order: "порядок",
  chart: "график",
  timeline: "хронология",
  tree: "дерево",
  commands: "команды",
  "[ Done ]": "[ Готово ]",
  "[ Send ]": "[ Отправить ]",
  "[ copy ]": "[ скопировать ]",
  "waiting for you · click an item": "ждёт вас · кликните по пункту",
  "↑↓ choose · 1-9 at once · Enter": "↑↓ выбор · 1-9 сразу · Enter",
  "↑↓ · Space marks · a all · Enter": "↑↓ · Пробел отметка · a всё · Enter",
  "type · Enter sends": "ввод · Enter отправить",
  "click and answer in the chat": "кликните и ответьте в чате",
  "↑↓/Tab fields · ←→ choose · Enter": "↑↓/Tab поля · ←→ выбор · Enter",
  "[x] yes": "[x] да",
  "[ ] no": "[ ] нет",
  "  [ Done ]": "  [ Готово ]",
  "←→ change · digit · Enter": "←→ изменение · цифра · Enter",
  "↑↓ · Enter picks a row": "↑↓ · Enter выбор строки",
  "… {count} more lines": "… ещё {count} строк",
  "c — copy": "c — скопировать",
  "←→ pages": "←→ страницы",
  "  ▲ up": "  ▲ вверх",
  "↑↓ move item · click — up · Enter": "↑↓ переместить · клик — вверх · Enter",
  "↑↓ · Enter picks": "↑↓ · Enter выбрать",
  "↑↓ · Enter runs · c copies": "↑↓ · Enter запуск · c копировать",
  Copied: "Скопировано",
}

function interpolate(template: string, values?: Record<string, string | number>) {
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}

export function tr(text: string, values?: Record<string, string | number>): string {
  const template = currentLanguage === "ru" && text in ruDict ? ruDict[text] : text
  return interpolate(template, values)
}
