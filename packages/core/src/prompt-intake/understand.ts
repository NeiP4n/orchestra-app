export * as PromptIntakeUnderstand from "./understand.js"

import { isContinuation, keywords, sentences, stem, tokens } from "./normalize.js"
import type { Ambiguity, IntakeContext, StructuredTask } from "./types.js"

const CONSTRAINT_MARKERS = [
  "не ", "нельзя", "только", "без ", "never", "only", "must not", "don't", "do not", "no ",
  "лимит", "бюджет", "максимум", "не больше", "не менее", "минимум", "обязательно", "запрещено",
]

const VAGUE_WORDS: ReadonlyArray<{ word: string; question: string; assumption: string }> = [
  {
    word: "лучше",
    question: "Что значит «лучше» — быстрее, надёжнее, проще?",
    assumption: "«Лучше» читаю как «быстрее и без потери надёжности».",
  },
  {
    word: "нормально",
    question: "Что значит «нормально» — какой измеримый результат?",
    assumption: "«Нормально» читаю как «работает без ошибок в обычном сценарии».",
  },
  {
    word: "хорошо",
    question: "Что значит «хорошо» — какой критерий?",
    assumption: "«Хорошо» читаю как «по принятым в проекте стандартам качества».",
  },
  {
    word: "как-нибудь",
    question: "«Как-нибудь» — любой способ подойдёт или есть предпочтения?",
    assumption: "Способ выбираю сам, самый простой из надёжных.",
  },
  {
    word: "что-то",
    question: "«Что-то» — что именно не так?",
    assumption: "Ищу самую заметную проблему в указанной области.",
  },
  {
    word: "оптимизируй",
    question: "Что оптимизировать: скорость, память, размер?",
    assumption: "Оптимизирую скорость, не меняя поведение.",
  },
  {
    word: "улучши",
    question: "Что именно улучшить и как это измерить?",
    assumption: "Улучшаю самое слабое место, которое найду.",
  },
  {
    word: "разберись",
    question: "«Разберись» — найти причину или сразу исправить?",
    assumption: "Сначала нахожу причину, потом исправляю.",
  },
]

const FILE_PATTERN = /[\w./-]+\.(?:ts|tsx|js|jsx|md|json|yaml|yml|toml|py|rs|go|java|kt|css|html|sh)\b/g
const URL_PATTERN = /https?:\/\/[^\s]+/g

type VerbClass = "fix" | "build" | "research" | "question" | "review" | "test" | "other"

const VERB_CLASSES: ReadonlyArray<{ verbClass: VerbClass; stems: ReadonlyArray<string> }> = [
  { verbClass: "fix", stems: ["исправ", "пофикс", "почин", "fix", "bug"] },
  { verbClass: "build", stems: ["созда", "добав", "реализу", "постро", "create", "add", "implement", "build"] },
  { verbClass: "research", stems: ["най", "исслед", "сравн", "изуч", "find", "research", "compare"] },
  { verbClass: "test", stems: ["провер", "протест", "тест", "test", "check"] },
  { verbClass: "question", stems: ["объясн", "explain", "how", "what", "why"] },
  { verbClass: "review", stems: ["ревь", "review", "посмотр"] },
]

// Token-based matching: `\b` in JS only knows ASCII word characters, so it
// never matches Cyrillic word boundaries. Stems make verb forms agree, and
// a prefix match covers the remaining inflection ("исследуй" ~ "исслед").
function stemMatches(tokenStem: string, classStem: string): boolean {
  if (tokenStem.length < 4 || classStem.length < 4) return tokenStem === classStem
  return tokenStem.startsWith(classStem) || classStem.startsWith(tokenStem)
}

function verbClass(text: string): VerbClass {
  const stems = tokens(text).map((token) => stem(token))
  for (const entry of VERB_CLASSES) {
    if (entry.stems.some((verbStem) => stems.some((tokenStem) => stemMatches(tokenStem, verbStem)))) {
      return entry.verbClass
    }
  }
  if (text.trim().endsWith("?")) return "question"
  return "other"
}

const ACTION_STEMS = [
  "сдела", "исправ", "добав", "созда", "напис", "провер", "най", "объясн",
  "запуст", "обнов", "удал", "реализу", "постро", "fix", "add", "create", "write", "check",
  "find", "explain", "run", "update", "remove", "implement", "build", "test",
]

function hasActionVerb(text: string): boolean {
  const stems = tokens(text).map((token) => stem(token))
  return ACTION_STEMS.some((actionStem) => stems.some((tokenStem) => stemMatches(tokenStem, actionStem)))
}

const PLAN_TEMPLATES: Record<VerbClass, ReadonlyArray<string>> = {
  fix: ["Воспроизвести проблему", "Найти причину", "Исправить", "Проверить исправление и прогнать связанные тесты"],
  build: ["Уточнить требования", "Спроектировать", "Реализовать", "Проверить и показать результат"],
  research: ["Собрать источники", "Сравнить варианты", "Сделать вывод с доказательствами"],
  question: ["Найти ответ в коде или документации", "Ответить коротко и по делу"],
  review: ["Прочитать код", "Отметить проблемы с доказательствами", "Предложить исправления"],
  test: ["Определить, что проверять", "Написать или прогнать тесты", "Сообщить результат"],
  other: ["Уточнить задачу", "Выполнить", "Проверить результат"],
}

/**
 * Heuristic deep processing: rules first, no model. Turns a raw prompt into
 * a structured task the agent can act on without guessing. The model pass
 * (when needed) only refines the ambiguities this produces.
 */
export function understand(text: string, _context: IntakeContext): StructuredTask {
  const trimmed = text.trim()
  if (isContinuation(trimmed)) {
    return {
      goal: trimmed,
      context: [],
      constraints: [],
      dod: ["Продолжить текущую работу"],
      ambiguities: [],
      plan: ["Продолжить текущую работу"],
      keywords: keywords(trimmed),
      needsModel: false,
    }
  }
  const lines = sentences(trimmed)
  const goal = lines[0] ?? trimmed
  const rest = lines.slice(1)

  const context: Array<string> = [...rest]
  const files = trimmed.match(FILE_PATTERN) ?? []
  const urls = trimmed.match(URL_PATTERN) ?? []
  for (const file of new Set(files)) context.push(`Упомянут файл: ${file}`)
  for (const url of new Set(urls)) context.push(`Упомянута ссылка: ${url}`)

  const constraints = lines.filter((line) => {
    const lower = line.toLowerCase()
    return CONSTRAINT_MARKERS.some((marker) => lower.includes(marker))
  })

  const dod = [
    `${goal} — выполнено`,
    "Результат проверен: связанные проверки пройдены",
    "Нет регрессий в смежной работе",
  ]
  if (/тест/i.test(trimmed)) dod.splice(1, 0, "Тесты добавлены или обновлены")

  const ambiguities: Array<Ambiguity> = []
  const lower = trimmed.toLowerCase()
  for (const vague of VAGUE_WORDS) {
    if (lower.includes(vague.word) && ambiguities.length < 3) {
      ambiguities.push({ question: vague.question, assumption: vague.assumption })
    }
  }
  const verb = verbClass(trimmed)
  if ((verb === "fix" || verb === "build") && files.length === 0 && ambiguities.length < 3) {
    ambiguities.push({
      question: "В каком файле или модуле работать?",
      assumption: "Найду место работы сам по ключевым словам задачи.",
    })
  }
  if (constraints.length === 0 && ambiguities.length < 3) {
    ambiguities.push({
      question: "Как поймём, что готово?",
      assumption: "Считаю готовым, когда цель достигнута и проверка пройдена.",
    })
  }

  const words = keywords(trimmed)
  const needsModel =
    ambiguities.length >= 2 || (!hasActionVerb(trimmed) && !trimmed.endsWith("?")) || words.length < 3

  return {
    goal,
    context,
    constraints,
    dod,
    ambiguities: ambiguities.slice(0, 3),
    plan: PLAN_TEMPLATES[verb],
    keywords: words,
    needsModel,
  }
}
