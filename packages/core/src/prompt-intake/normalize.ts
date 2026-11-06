export * as PromptIntakeNormalize from "./normalize.js"

// Small stopword lists for the two languages prompts arrive in. Kept short
// on purpose: the keyword lists only feed similarity and skill matching,
// where a missed stopword costs less than a dropped content word.
const STOPWORDS = new Set([
  "и", "в", "на", "с", "по", "для", "что", "это", "как", "так", "же", "но", "а", "или", "из", "от", "к", "у", "о", "об",
  "не", "да", "нет", "бы", "быть", "есть", "был", "была", "были", "будет", "будут", "мне", "меня", "мой", "моя", "моё",
  "тот", "этот", "эта", "эти", "того", "этого", "том", "этом", "который", "которая", "которое", "которые",
  "еще", "ещё", "уже", "тоже", "также", "очень", "сам", "сама", "сами", "все", "всё", "всех", "всем", "всю",
  "надо", "нужно", "пожалуйста", "давай", "давайте", "просто", "тогда", "потом", "сейчас", "тут", "там", "вот",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were", "be", "been",
  "it", "this", "that", "these", "those", "i", "you", "we", "they", "he", "she", "my", "your", "our", "their",
  "do", "does", "did", "can", "could", "should", "would", "please", "just", "then", "now", "here", "there",
])

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[«»""''„“`]/g, '"')
    .replace(/[^a-zа-яё0-9\s/._-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function tokens(text: string): ReadonlyArray<string> {
  return normalize(text)
    .split(" ")
    .filter((token) => token.length > 0)
}

export function keywords(text: string): ReadonlyArray<string> {
  return Array.from(
    new Set(
      tokens(text).filter((token) => token.length >= 2 && !STOPWORDS.has(token)),
    ),
  )
}

export function sentences(text: string): ReadonlyArray<string> {
  // Split only where a sentence really ends: a dot inside a file path
  // ("prompt.ts") or a version ("1.0.0") must not split, so the next word
  // has to start with a capital letter.
  return text
    .split(/(?<=[.!?])\s+(?=[А-ЯA-Z])|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

// Irregular imperative → infinitive pairs the suffix stripper cannot reach.
const IRREGULAR: Readonly<Record<string, string>> = {
  "собери": "собрать",
  "соберите": "собрать",
  "найди": "найти",
  "найдите": "найти",
  "напиши": "написать",
  "напишите": "написать",
}

// Longest first. Cyrillic suffixes are inflectional endings (verb forms,
// noun cases); Latin suffixes are the English -ing/-ed/-s. Only strip when
// at least 3 letters remain, so short words ("тест", "bug") survive.
const SUFFIXES = [
  "аться", "яться", "еться", "иться",
  "ать", "ять", "еть", "ить",
  "ешься", "ешь", "ете", "ет", "ем", "ут", "ют",
  "ла", "ло", "ли",
  "йся", "й", "ь",
  "ов", "ев", "ам", "ям", "ах", "ях", "ой", "ей", "ом", "ем",
  "а", "я", "ю", "е", "и", "о", "у", "ы",
  "ing", "ed", "es", "s",
]

/**
 * Light stemmer: "исправь" and "исправить" both become "исправ", "тесты"
 * and "тест" both become "тест". Used for matching only — the original
 * words are what the agent sees.
 */
export function stem(word: string): string {
  const irregular = IRREGULAR[word]
  if (irregular) return stem(irregular)
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) {
      return word.slice(0, word.length - suffix.length)
    }
  }
  return word
}

/** Stems of the content keywords, deduplicated. */
export function keywordStems(text: string): ReadonlyArray<string> {
  return Array.from(new Set(keywords(text).map((word) => stem(word))))
}

// Short replies that continue the current work instead of starting a new
// task. The intake passes them through untouched: there is nothing to
// structure, and wrapping them would only add noise to the transcript.
const CONTINUATIONS = new Set([
  "продолжай", "продолжи", "продолжайте", "дальше", "да", "ок", "окей", "ещё", "еще", "ага", "давай",
  "continue", "go on", "yes", "ok", "okay", "yep", "yeah",
])

export function isContinuation(text: string): boolean {
  return CONTINUATIONS.has(normalize(text))
}
