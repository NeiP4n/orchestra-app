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

// Words a prompt can consist of entirely when it carries no task:
// greetings, thanks, and short acknowledgements. The trivial check
// requires EVERY word to be one of these, so a real task ("исправь
// тесты", "тесты падают") can never match — it always has at least one
// content word. Multi-word acknowledgements ("спасибо за помощь",
// "так, давай") match because each word is in the set.
const TRIVIAL_WORDS = new Set([
  // Russian greetings.
  "привет", "здравствуй", "здравствуйте", "прив", "хай", "салют", "здорово",
  "добрый", "день", "вечер", "утро",
  // Russian thanks (and their usual completions).
  "спасибо", "благодарю", "большое", "огромное", "за", "помощь", "помощью", "работу", "тебе", "вам", "всем",
  // Russian acknowledgements and confirmations.
  "отлично", "хорошо", "супер", "класс", "классно", "прекрасно", "замечательно", "чудесно",
  "великолепно", "круто", "норм", "нормально", "молодец",
  "понял", "поняла", "понятно", "ясно", "ладно", "договорились",
  "да", "да-да", "ага", "угу", "ок", "окей",
  // Continuation words, so "так, давай" and "давай, отлично" match too.
  "давай", "давайте", "продолжай", "продолжи", "продолжайте", "дальше", "ещё", "еще",
  // Russian fillers that only appear inside acknowledgements.
  "всё", "все", "это", "так", "очень", "же", "ну", "вот", "пожалуйста",
  // English greetings.
  "hello", "hi", "hey", "good", "morning", "afternoon", "evening",
  // English thanks.
  "thanks", "thank", "you", "thx",
  // English acknowledgements and confirmations.
  "great", "excellent", "perfect", "nice", "awesome", "cool", "super", "fine",
  "job", "work",
  "got", "it", "understood", "ok", "okay", "yes", "yep", "yeah", "sure", "well", "done",
  // English continuations.
  "continue", "go", "on",
])

/**
 * True when the prompt carries no task at all: a greeting, a thank-you,
 * or a short acknowledgement ("отлично", "привет", "спасибо"). Continuations
 * are trivial too. Purely lexical (no model call): the prompt must be
 * short (at most 6 words) and every word must be a known acknowledgement
 * word. A real task always has a content word, so it can never match.
 * An empty prompt is not trivial — it still needs the value check's
 * "clarify" verdict.
 */
export function isTrivial(text: string): boolean {
  const normalized = normalize(text)
  if (normalized.length === 0) return false
  if (isContinuation(text)) return true
  const words = normalized.split(" ").filter((word) => word.length > 0)
  if (words.length === 0 || words.length > 6) return false
  return words.every((word) => TRIVIAL_WORDS.has(word))
}

export function isContinuation(text: string): boolean {
  return CONTINUATIONS.has(normalize(text))
}
