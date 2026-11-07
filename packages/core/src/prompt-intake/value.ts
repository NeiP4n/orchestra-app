export * as PromptIntakeValue from "./value.js"

import { isContinuation, keywords, sentences } from "./normalize.js"
import { similarity } from "./similarity.js"
import type { IntakeContext, ValueAssessment } from "./types.js"

// A match this strong means "same work", not "same topic".
const MERGE_THRESHOLD = 0.55
// A done item needs a stronger match to claim the work is already finished.
const DONE_THRESHOLD = 0.6
// A repeated user prompt needs a strong match: follow-ups share words too.
const REPEAT_THRESHOLD = 0.7

const DONE_STATES = ["done", "complete", "completed", "closed", "accepted", "verified", "готово", "завершено", "закрыто"]

function isDone(state: string): boolean {
  const normalized = state.toLowerCase()
  return DONE_STATES.some((done) => normalized.includes(done))
}

const QUESTION_STARTERS = ["как", "что", "почему", "зачем", "где", "когда", "какой", "какая", "какое", "какие", "how", "what", "why", "where", "when", "which"]

const ACTION_VERBS = [
  "сделай", "сделать", "исправь", "исправить", "пофикси", "починь", "добавь", "добавить", "создай", "создать",
  "напиши", "написать", "проверь", "проверить", "найди", "найти", "объясни", "объяснить", "помоги", "помочь",
  "разберись", "запусти", "запустить", "обнови", "обновить", "удали", "удалить", "реализуй", "реализовать",
  "построй", "построить", "настрой", "настроить", "протестируй", "протестировать", "перепиши", "переписать",
  "оптимизируй", "оптимизировать", "улучши", "улучшить", "подготовь", "подготовить", "разбей", "разбить",
  "fix", "add", "create", "write", "check", "find", "explain", "help", "run", "update", "remove", "delete",
  "implement", "build", "test", "refactor", "optimize", "improve", "prepare", "setup", "configure", "review",
]

function isQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.endsWith("?")) return true
  const first = trimmed.toLowerCase().split(/\s+/)[0]?.replace(/[^a-zа-яё]/gu, "")
  return first !== undefined && QUESTION_STARTERS.includes(first)
}

function hasActionVerb(text: string): boolean {
  const lower = text.toLowerCase()
  return ACTION_VERBS.some((verb) => lower.includes(verb))
}

/**
 * Cheap, model-free value check. Runs before any deep processing so tokens
 * are never spent on work that already exists. Pure: every verdict carries
 * the evidence it is based on, and a source that was not consulted is
 * reported instead of silently treated as "no match".
 */
export function checkValue(text: string, context: IntakeContext): ValueAssessment {
  const sources = context.sources
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return {
      verdict: "clarify",
      confidence: 0.9,
      reasons: ["Промпт пустой: непонятно, что делать."],
      evidence: [],
      questions: ["Что нужно сделать?"],
      sources,
    }
  }
  if (isContinuation(trimmed)) {
    return {
      verdict: "execute",
      confidence: 0.95,
      reasons: ["Продолжение текущей работы — не новая задача."],
      evidence: [],
      questions: [],
      sources,
    }
  }
  const words = keywords(trimmed)
  if (words.length < 2) {
    return {
      verdict: "clarify",
      confidence: 0.8,
      reasons: ["Промпт слишком короткий: из него нельзя понять задачу."],
      evidence: [],
      questions: ["Что именно нужно сделать?", "Какой результат ожидается?"],
      sources,
    }
  }

  // 1. Already done beats everything: never redo finished work.
  const doneMatch = bestMatch(trimmed, context.dodItems.filter((item) => isDone(item.state)))
  if (doneMatch && doneMatch.score >= DONE_THRESHOLD) {
    return {
      verdict: "skip",
      confidence: doneMatch.score,
      reasons: [`Работа уже сделана: задача «${doneMatch.item.title}» закрыта.`],
      evidence: [{ kind: "dod-done", ref: doneMatch.item.id, title: doneMatch.item.title, score: doneMatch.score }],
      questions: [],
      sources,
    }
  }
  const succeededRepeat = bestTextMatch(trimmed, context.recentPrompts.filter((prompt) => prompt.outcome === "succeeded"))
  if (succeededRepeat && succeededRepeat.score >= REPEAT_THRESHOLD) {
    return {
      verdict: "skip",
      confidence: succeededRepeat.score,
      reasons: ["Такой запрос уже выполнялся успешно в этой сессии — результат уже есть."],
      evidence: [{ kind: "session-history", ref: "recent", title: succeededRepeat.text, score: succeededRepeat.score }],
      questions: [],
      sources,
    }
  }

  // 2. Same work already exists: merge into it instead of starting a second one.
  const openMatch = bestMatch(trimmed, context.dodItems.filter((item) => !isDone(item.state)))
  if (openMatch && openMatch.score >= MERGE_THRESHOLD) {
    return {
      verdict: "merge",
      confidence: openMatch.score,
      reasons: [`Такая задача уже есть: «${openMatch.item.title}». Новая работа должна влиться в неё, а не начаться отдельно.`],
      evidence: [{ kind: "dod-open", ref: openMatch.item.id, title: openMatch.item.title, score: openMatch.score }],
      questions: [],
      sources,
    }
  }
  const repeat = bestTextMatch(trimmed, context.recentPrompts)
  if (repeat && repeat.score >= REPEAT_THRESHOLD) {
    return {
      verdict: "merge",
      confidence: repeat.score,
      reasons: ["Такой запрос уже был в этой сессии — это повтор, а не новая задача."],
      evidence: [{ kind: "session-history", ref: "recent", title: repeat.text, score: repeat.score }],
      questions: [],
      sources,
    }
  }
  const journalMatch = bestJournalMatch(trimmed, context.journalTitles)
  if (journalMatch && journalMatch.score >= REPEAT_THRESHOLD) {
    // A failed earlier attempt is not a duplicate to merge into: the work
    // does not exist, it has to be done again. A retry is legitimate, so it
    // executes — with the failure named, so the agent investigates the
    // failure first instead of blindly restarting.
    if (journalMatch.item.outcome === "failed") {
      return {
        verdict: "execute",
        confidence: journalMatch.score,
        reasons: [
          `Такая задача уже есть в журнале autoloop («${journalMatch.item.title}») и она падала — сначала разберись, почему она упала, а не начинай заново.`,
        ],
        evidence: [{ kind: "autoloop-journal", ref: journalMatch.item.title, title: journalMatch.item.title, score: journalMatch.score }],
        questions: [],
        sources,
      }
    }
    return {
      verdict: "merge",
      confidence: journalMatch.score,
      reasons: [
        `Такая задача уже есть в журнале autoloop («${journalMatch.item.title}»).`,
      ],
      evidence: [{ kind: "autoloop-journal", ref: journalMatch.item.title, title: journalMatch.item.title, score: journalMatch.score }],
      questions: [],
      sources,
    }
  }

  // 3. Too vague to act on: ask, do not guess.
  const questions: Array<string> = []
  if (!hasActionVerb(trimmed) && !isQuestion(trimmed)) {
    questions.push("Что нужно сделать: исправить, создать, проверить или объяснить?")
  }
  // A question is a clear task by itself (answer it); only a short
  // non-question statement is too vague to act on.
  if (!isQuestion(trimmed) && sentences(trimmed).length === 1 && words.length < 5) {
    questions.push("Уточни, что именно должно получиться на выходе?")
  }
  const scope = context.projectScope ?? []
  if (scope.length > 0 && !words.some((word) => scope.includes(word))) {
    questions.push("Это точно про этот проект? Похоже, задача из другой области.")
  }
  if (questions.length > 0) {
    return {
      verdict: "clarify",
      confidence: 0.65,
      reasons: ["Промпт расплывчатый: из него нельзя однозначно понять задачу."],
      evidence: [],
      questions: questions.slice(0, 3),
      sources,
    }
  }

  // 4. Clear and actionable.
  return {
    verdict: "execute",
    confidence: hasActionVerb(trimmed) || isQuestion(trimmed) ? 0.85 : 0.7,
    reasons: ["Промпт ясный: есть действие и понятный результат."],
    evidence: [],
    questions: [],
    sources,
  }
}

function bestMatch(
  text: string,
  items: ReadonlyArray<{ id: string; title: string; state: string }>,
): { item: { id: string; title: string; state: string }; score: number } | undefined {
  let best: { item: { id: string; title: string; state: string }; score: number } | undefined
  for (const item of items) {
    const score = similarity(text, item.title)
    if (!best || score > best.score) best = { item, score }
  }
  return best
}

function bestTextMatch(
  text: string,
  prompts: ReadonlyArray<{ text: string; outcome?: string }>,
): { text: string; score: number } | undefined {
  let best: { text: string; score: number } | undefined
  for (const prompt of prompts) {
    const score = similarity(text, prompt.text)
    if (!best || score > best.score) best = { text: prompt.text, score }
  }
  return best
}

function bestJournalMatch(
  text: string,
  entries: ReadonlyArray<{ title: string; outcome?: string }>,
): { item: { title: string; outcome?: string }; score: number } | undefined {
  let best: { item: { title: string; outcome?: string }; score: number } | undefined
  for (const item of entries) {
    const score = similarity(text, item.title)
    if (!best || score > best.score) best = { item, score }
  }
  return best
}
