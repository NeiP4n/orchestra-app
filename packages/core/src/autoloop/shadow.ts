// Оркестратор-дублёр (идея #8 из лучших 25 общего подхода).
//
// Главный оркестратор работает, а теневой молча следит за его решениями и
// раз в сутки пишет, с чем не согласен. Этот модуль — только механизм:
// читает журнал решений оркестратора (autoloop journal), готовит шаблон
// сессии для теневого разбора и хранит дайджест в каталоге общества.
// Содержимое дайджеста пишет агент-сессия; здесь нет модели и нет
// собственных суждений — только факты из журнала и их подсчёт.
//
// Файлы ядра autoloop здесь не трогаются: модуль читает готовое
// представление (`View`) через `rows` из kernel/evolve и ничего не пишет
// в журнал. Записи решений — это строки `runs` (законченные запуски),
// `cards` (отвеченные карточки) и `events` (записанные события) за окно.

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { rows } from "./kernel/evolve.js"
import type { View } from "./kernel/evolve.js"
import type { CardRow, EventRow, RunRow } from "./kernel/decide.js"

// Каталог общества по умолчанию — внутри каталога данных Orchestra
// (`<data>/society`); дайджесты лежат в его подкаталоге `shadow`.
export const SOCIETY_DIR_NAME = "society"
export const SHADOW_DIR_NAME = "shadow"

/** Одно решение оркестратора, прочитанное из журнала. */
export interface ShadowDecision {
  /** `run:<id>`, `card:<id>` или `event:<id>` — ссылка на строку журнала. */
  id: string
  kind: "run" | "card" | "event"
  agent: string | null
  rule: string | null
  lane: string | null
  /** Итоговое состояние: `done`, `failed`, `nothing`, `cancelled`, ... */
  state: string
  summary: string
  error: string | null
  attempts: number
  /** Время решения в ISO, или null, когда журнал его не хранит. */
  at: string | null
}

/** Подсчёт решений за окно — факты для шаблона сессии и дайджеста. */
export interface ShadowSummary {
  total: number
  byState: Record<string, number>
  byAgent: Record<string, number>
  byRule: Record<string, number>
  /** Законченные запуски с ошибкой или провалом. */
  failed: ShadowDecision[]
  /** Запуски, которым понадобилась повторная попытка. */
  retried: ShadowDecision[]
  /** Карточки, оставшиеся без ответа. */
  unansweredCards: number
}

/** Одно несогласие теневого оркестратора с решением главного. */
export interface ShadowDisagreement {
  /** Ссылка на решение, например `run:12`. */
  decisionId: string
  /** С чем именно не согласен теневой оркестратор. */
  claim: string
  /** Почему: довод с опорой на факты журнала. */
  reason: string
}

const dayString = (date: Date): string => date.toISOString().slice(0, 10)

export const digestFilename = (date: Date): string => `shadow-digest-${dayString(date)}.md`

export const promptFilename = (date: Date): string => `shadow-prompt-${dayString(date)}.md`

export const digestPath = (societyDir: string, date: Date): string =>
  path.join(societyDir, SHADOW_DIR_NAME, digestFilename(date))

export const promptPath = (societyDir: string, date: Date): string =>
  path.join(societyDir, SHADOW_DIR_NAME, promptFilename(date))

const inWindow = (at: string | null, sinceMs: number, untilMs: number): boolean => {
  if (at === null) return false
  const ms = Date.parse(at)
  return !Number.isNaN(ms) && ms >= sinceMs && ms < untilMs
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "")

const nullText = (value: unknown): string | null => (typeof value === "string" ? value : null)

const numOf = (value: unknown): number => (typeof value === "number" ? value : 0)

/**
 * Решения оркестратора за окно `[sinceMs, untilMs)` из готового
 * представления журнала. Запуск попадает сюда, когда он закончен в окне
 * (`finished_at`); карточка — когда на неё ответили (`decided_at`);
 * событие — когда оно записано (`received_at`). Незаконченные запуски
 * и неотвеченные карточки в список не входят — по ним ещё нет решения.
 */
export function collectDecisions(view: View, sinceMs: number, untilMs: number): ShadowDecision[] {
  const decisions: ShadowDecision[] = []
  for (const { data } of rows(view, "runs")) {
    const run = data as unknown as RunRow
    if (!inWindow(run.finished_at, sinceMs, untilMs)) continue
    decisions.push({
      id: `run:${run.id}`,
      kind: "run",
      agent: run.agent,
      rule: run.rule,
      lane: run.lane,
      state: run.state,
      summary: textOf(run.summary),
      error: nullText(run.error),
      attempts: numOf(run.attempts),
      at: run.finished_at,
    })
  }
  for (const { data } of rows(view, "cards")) {
    const card = data as unknown as CardRow
    if (!inWindow(card.decided_at, sinceMs, untilMs)) continue
    decisions.push({
      id: `card:${card.id}`,
      kind: "card",
      agent: card.agent,
      rule: card.rule,
      lane: card.lane,
      state: card.state,
      summary: card.title,
      error: null,
      attempts: 0,
      at: card.decided_at,
    })
  }
  for (const { data } of rows(view, "events")) {
    const event = data as unknown as EventRow
    if (!inWindow(event.received_at, sinceMs, untilMs)) continue
    decisions.push({
      id: `event:${event.id}`,
      kind: "event",
      agent: null,
      rule: null,
      lane: null,
      state: event.type,
      summary: event.summary || event.subject,
      error: null,
      attempts: numOf(event.hops),
      at: event.received_at,
    })
  }
  return decisions.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))
}

/** Подсчёт решений: сколько и каких исходов, кто и по каким правилам решал. */
export function summarizeDecisions(decisions: ReadonlyArray<ShadowDecision>): ShadowSummary {
  const byState: Record<string, number> = {}
  const byAgent: Record<string, number> = {}
  const byRule: Record<string, number> = {}
  let unansweredCards = 0
  for (const decision of decisions) {
    byState[decision.state] = (byState[decision.state] ?? 0) + 1
    if (decision.agent !== null) byAgent[decision.agent] = (byAgent[decision.agent] ?? 0) + 1
    if (decision.rule !== null) byRule[decision.rule] = (byRule[decision.rule] ?? 0) + 1
  }
  return {
    total: decisions.length,
    byState,
    byAgent,
    byRule,
    failed: decisions.filter((decision) => decision.kind === "run" && decision.state === "failed"),
    retried: decisions.filter((decision) => decision.kind === "run" && decision.attempts > 1),
    unansweredCards,
  }
}

/** Число неотвеченных карточек на момент снятия представления журнала. */
export function countUnansweredCards(view: View): number {
  return rows(view, "cards").filter(({ data }) => (data as unknown as CardRow).state === "open").length
}

const countLines = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `- ${name}: ${count}`)
    .join("\n")

const decisionLine = (decision: ShadowDecision): string => {
  const when = decision.at ?? "без времени"
  const agent = decision.agent ?? "—"
  const rule = decision.rule ?? "—"
  const extra = decision.error !== null ? ` — ошибка: ${decision.error}` : ""
  const summary = decision.summary !== "" ? ` — ${decision.summary}` : ""
  return `- \`${decision.id}\` [${when}] ${decision.kind} ${decision.state}, агент ${agent}, правило ${rule}${summary}${extra}`
}

/**
 * Шаблон сессии теневого оркестратора: промпт, который агент-сессия
 * разбирает за сутки. Внутри — только факты из журнала: список решений
 * и подсчёт. Сессия пишет свои несогласия отдельным файлом, а не правит
 * этот шаблон.
 */
export function renderSessionPrompt(date: Date, decisions: ReadonlyArray<ShadowDecision>, summary: ShadowSummary): string {
  const lines = [
    `# Теневой оркестратор — разбор за ${dayString(date)}`,
    "",
    "Ты — теневой оркестратор. Главный оркестратор работает сам; ты молча",
    "следишь за его решениями и раз в сутки пишешь, с чем не согласен.",
    "Ты ничего не меняешь в работе общества и ни с кем не споришь в процессе —",
    "только этот разбор.",
    "",
    "## Правила разбора",
    "",
    "- Не соглашайся только с тем, что можешь опереть на факт из списка ниже.",
    "  Каждое несогласие ссылается на решение по его id (`run:<n>`, `card:<n>`, `event:<n>`).",
    "- Не выдумывай решения, которых нет в списке, и не суди о том, чего журнал не хранит.",
    "- Если решение выглядит верным — так и скажи: молчаливое согласие не пишется.",
    "- Спорное, но недоказуемое, отмечай отдельно как вопрос, а не как несогласие.",
    "- Сначала смотри провалы и повторы: `failed`, `nothing` после повторов,",
    "  карточки без ответа, один и тот же агент с одними и теми же ошибками.",
    "",
    "## Решения главного оркестратора за сутки",
    "",
    `Всего решений: ${summary.total}. По исходам:`,
    countLines(summary.byState) || "- нет решений",
    "",
    "По агентам:",
    countLines(summary.byAgent) || "- нет решений",
    "",
    "По правилам:",
    countLines(summary.byRule) || "- нет решений",
    "",
    `Провалов: ${summary.failed.length}. Повторных попыток: ${summary.retried.length}.`,
    `Неотвеченных карточек сейчас: ${summary.unansweredCards}.`,
    "",
    ...decisions.map(decisionLine),
    "",
    "## Что написать",
    "",
    "Напиши файл несогласий: по одному разделу на каждое несогласие —",
    "id решения, с чем не согласен, почему и что предлагаешь вместо.",
    "Отдельно — вопросы без доказательства и одно предложение: что главному",
    "оркестратору стоит изменить завтра. Если несогласий нет — напиши об этом",
    "одной строкой: молчаливое согласие тоже результат.",
    "",
  ]
  return lines.join("\n")
}

/**
 * Дайджест несогласий за сутки: шапка с подсчётом проверенных решений
 * и текст сессии как есть. Текст сессии не переписывается — дайджест
 * хранит именно то, что написал теневой оркестратор.
 */
export function renderDigest(date: Date, summary: ShadowSummary, sessionText: string): string {
  return [
    `# Дайджест теневого оркестратора — ${dayString(date)}`,
    "",
    `Проверено решений главного оркестратора: ${summary.total} ` +
      `(провалов: ${summary.failed.length}, повторных попыток: ${summary.retried.length}, ` +
      `неотвеченных карточек: ${summary.unansweredCards}).`,
    "",
    sessionText.trim(),
    "",
  ].join("\n")
}

/** Дайджест из структурированного списка несогласий (без текста сессии). */
export function renderDigestFromDisagreements(
  date: Date,
  summary: ShadowSummary,
  disagreements: ReadonlyArray<ShadowDisagreement>,
): string {
  if (disagreements.length === 0) {
    return renderDigest(date, summary, "Несогласий нет: все проверенные решения выглядят верными.")
  }
  const body = disagreements
    .map(
      (disagreement) =>
        `## ${disagreement.decisionId}\n\nНе согласен: ${disagreement.claim}\n\nПочему: ${disagreement.reason}`,
    )
    .join("\n\n")
  return renderDigest(date, summary, body)
}

/** Пишет файл в каталог `shadow/` внутри каталога общества, создавая его. */
export async function writeShadowFile(societyDir: string, filename: string, content: string): Promise<string> {
  const dir = path.join(societyDir, SHADOW_DIR_NAME)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, filename)
  await writeFile(file, content, "utf8")
  return file
}

/** Пишет шаблон сессии за дату в каталог общества, возвращает путь. */
export async function writeSessionPrompt(
  societyDir: string,
  date: Date,
  decisions: ReadonlyArray<ShadowDecision>,
  summary: ShadowSummary,
): Promise<string> {
  return writeShadowFile(societyDir, promptFilename(date), renderSessionPrompt(date, decisions, summary))
}

/** Пишет дайджест за дату в каталог общества, возвращает путь. */
export async function writeDigest(
  societyDir: string,
  date: Date,
  summary: ShadowSummary,
  sessionText: string,
): Promise<string> {
  return writeShadowFile(societyDir, digestFilename(date), renderDigest(date, summary, sessionText))
}
