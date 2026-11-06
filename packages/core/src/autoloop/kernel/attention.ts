export * as AutoloopAttention from "./attention.js"

import { MINUTE } from "./due.js"
import type { View } from "./evolve.js"
import type { Rules } from "./rules.js"

// Координация внимания (Agora MCP 0.8.4–0.8.6 — паттерны, не чужой код).
// Живой запуск (Б14) показал ту же боль, что Agora чинит у себя: агенты
// «засыпают», теряют контекст разговора и бросают задачи на полпути.
// Три механизма, перенесённые в ядро autoloop как чистые функции поверх
// журнала — без новых таблиц, без новых зависимостей, без MCP-клиента:
//
// (а) запрет остановки, пока должен ответ (0.8.6, Stop-хук): воркер не
//     завершается, пока в его треде висит неотвеченный вопрос;
// (б) thread-aware ответы (0.8.5): ответ всегда привязан к своему треду,
//     закрыть чужую карточку из квитанции нельзя;
// (в) replay пропущенного (0.8.4): вернувшийся агент получает события и
//     вопросы, пришедшие, пока его не было, — до 24 часов давности.
//
// Тред здесь — то, что ядро уже считает тредом: пара (правило, lane).
// Карточки квитанций уже ключуется `thread:<rule>:<lane>:<name>`
// (`cardFromReceipt` в decide.ts), а раунды одного треда делят сессию
// (`settleSession`). Этот модуль только читает журнал: решения, что делать
// с найденным, остаются в decide.ts.

/** Сколько открытых тредов проверяет один Stop-хук — как у Agora (0.8.6). */
export const MAX_CHECK_THREADS = 5

/** Как далеко назад смотрит replay пропущенного — как у Agora (0.8.4). */
export const REPLAY_WINDOW_MS = 24 * 60 * MINUTE

/** Сколько пропущенных штук отдаёт один replay, чтобы ответ не раздувался. */
export const REPLAY_MAX_ITEMS = 50

/** Тред: правило + lane, как в `threadOf` из decide.ts. */
export interface ThreadKey {
  rule: string
  lane: string
}

const threadKey = (thread: ThreadKey): string => `${thread.rule}\n${thread.lane}`

/** Один неотвеченный вопрос в треде раунда. */
export interface PendingReply {
  /** Карточка, которая ждёт ответа. */
  card: number
  /** Заголовок карточки, чтобы воркер понял, что от него хотят. */
  title: string
  rule: string
  lane: string
}

/** Что Stop-хук нашёл у воркера: можно ли ему останавливаться. */
export interface StopCheck {
  /** Останавливаться можно, только когда неотвеченного не осталось. */
  mayStop: boolean
  /** Неотвеченные вопросы в проверенных тредах. */
  pending: PendingReply[]
  /** Сколько тредов проверено (не больше MAX_CHECK_THREADS). */
  threadsChecked: number
  /** Сколько открытых тредов у воркера всего — больше проверенных, когда проверка урезана. */
  threadsTotal: number
  /** Проверка урезана лимитом тредов: за его пределами могло остаться неотвеченное. */
  truncated: boolean
}

/** Одна пропущенная штука: событие или вопрос, пришедшие, пока агента не было. */
export interface MissedItem {
  kind: "event" | "card"
  /** Номер события или карточки в журнале. */
  id: number
  /** Тип события или заголовок карточки. */
  title: string
  /** Короткое содержание: summary события или текст карточки. */
  summary: string
  rule: string
  lane: string
  /** Когда пришло, ISO. */
  at: string
}

/** Что вернувшийся агент пропустил, пока его не было. */
export interface ReplayResult {
  worker: string
  /** С какого момента собрано, ISO: последний seen воркера, но не раньше 24 часов назад. */
  since: string
  /** До какого момента собрано, ISO. */
  until: string
  /** Пропущенное по порядку: сначала старое. */
  missed: MissedItem[]
  /** Сколько кандидатов старше 24 часов отброшено и уже не вернуть. */
  droppedOlderThan24h: number
  /** Отсечено лимитом REPLAY_MAX_ITEMS: за его пределами могло остаться ещё. */
  truncated: boolean
}

type Row = Record<string, unknown>

const rowsOf = (view: View, collection: string): Array<{ key: string; data: Row }> =>
  Object.entries(view[collection] ?? {})
    .map(([key, data]) => ({ key, data: data as Row }))
    .sort((a, b) => {
      const na = Number(a.key)
      const nb = Number(b.key)
      if (Number.isInteger(na) && Number.isInteger(nb)) return na - nb
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    })

const text = (row: Row | undefined, field: string): string | undefined =>
  typeof row?.[field] === "string" ? (row[field] as string) : undefined

const num = (row: Row | undefined, field: string): number | undefined =>
  typeof row?.[field] === "number" ? (row[field] as number) : undefined

const isTerminalRun = (state: string | undefined): boolean =>
  state === "done" || state === "nothing" || state === "failed" || state === "cancelled"

/** Имена агентов, которые работают на этом воркере. */
export const agentsOfWorker = (rules: Rules, worker: string): string[] =>
  Object.entries(rules.agents)
    .filter(([, agent]) => agent.worker === worker)
    .map(([name]) => name)

/**
 * Неотвеченные вопросы в треде раунда: открытые ask-карточки того же
 * (правила, lane). Свои вопросы раунд не должен сам себе: карточка,
 * созданная этим раундом (`run_id`), — это вопрос другим, а не ему.
 */
export const pendingReplies = (view: View, run: { id: number; rule: string; lane: string }): PendingReply[] =>
  rowsOf(view, "cards")
    .map(({ data }) => data)
    .filter(
      (card) =>
        card["kind"] === "ask" &&
        card["state"] === "open" &&
        text(card, "rule") === run.rule &&
        text(card, "lane") === run.lane &&
        num(card, "run_id") !== run.id,
    )
    .map((card) => ({
      card: num(card, "id") ?? 0,
      title: text(card, "title") ?? "",
      rule: run.rule,
      lane: run.lane,
    }))

/**
 * Stop-хук (Agora 0.8.6): может ли воркер остановиться. Проверяет его
 * открытые треды — не больше MAX_CHECK_THREADS за раз, как у Agora.
 * Пусто в проверенных — можно останавливаться; за пределами проверки могло
 * остаться неотвеченное, об этом честно сказано в `truncated`.
 */
export const stopCheck = (view: View, worker: string, rules: Rules, runId?: number): StopCheck => {
  const runs = rowsOf(view, "runs")
    .map(({ data }) => data)
    .filter(
      (run) =>
        (runId === undefined || num(run, "id") === runId) &&
        (run["state"] === "claimed" || run["state"] === "unknown") &&
        agentsOfWorker(rules, worker).includes(text(run, "agent") ?? ""),
    )
  const threads = new Map<string, ThreadKey>()
  for (const run of runs) {
    const thread = { rule: text(run, "rule") ?? "", lane: text(run, "lane") ?? "" }
    threads.set(threadKey(thread), thread)
  }
  const all = [...threads.values()]
  const checked = all.slice(0, MAX_CHECK_THREADS)
  const checkedKeys = new Set(checked.map(threadKey))
  const pending = runs
    .filter((run) => checkedKeys.has(threadKey({ rule: text(run, "rule") ?? "", lane: text(run, "lane") ?? "" })))
    .flatMap((run) =>
      pendingReplies(view, { id: num(run, "id") ?? 0, rule: text(run, "rule") ?? "", lane: text(run, "lane") ?? "" }),
    )
  return {
    mayStop: pending.length === 0,
    pending,
    threadsChecked: checked.length,
    threadsTotal: all.length,
    truncated: all.length > checked.length,
  }
}

/**
 * Replay пропущенного (Agora 0.8.4): события и вопросы, пришедшие, пока
 * воркера не было. Начало окна — последний seen воркера, но не раньше
 * 24 часов назад; старше — отброшено и посчитано в `droppedOlderThan24h`.
 * Событие пропущено, пока его раунд не завершён; карточка — пока открыта
 * и задана в тред, который ведёт этот воркер.
 */
export const replayMissed = (view: View, worker: string, rules: Rules, now: number): ReplayResult => {
  const agents = new Set(agentsOfWorker(rules, worker))
  const seenAt = Date.parse(text(view["seen"]?.[`worker:${worker}`] as Row | undefined, "seen_at") ?? "")
  const windowStart = Math.max(Number.isNaN(seenAt) ? 0 : seenAt, now - REPLAY_WINDOW_MS)
  const runsById = new Map(
    rowsOf(view, "runs").map(({ data }) => [num(data, "id") ?? 0, data]),
  )
  const runOfEvent = (eventId: number): Row | undefined => {
    const link = rowsOf(view, "run_events").find(({ data }) => num(data, "event_id") === eventId)
    return link === undefined ? undefined : runsById.get(num(link.data, "run_id") ?? 0)
  }
  const eventItems: MissedItem[] = rowsOf(view, "events")
    .map(({ data }) => data)
    .filter((event) => {
      const at = Date.parse(text(event, "received_at") ?? "")
      if (Number.isNaN(at) || at < windowStart || at > now) return false
      const routed = (event["routed"] as Array<unknown> | undefined) ?? []
      const toWorker = routed.some(
        (ruleName) =>
          typeof ruleName === "string" && agents.has(rules.rules.find((rule) => rule.name === ruleName)?.to ?? ""),
      )
      if (!toWorker) return false
      const run = runOfEvent(num(event, "id") ?? 0)
      return run === undefined || !isTerminalRun(text(run, "state"))
    })
    .map((event) => {
      const ruleName =
        ((event["routed"] as Array<unknown> | undefined) ?? []).find(
          (name) => typeof name === "string" && agents.has(rules.rules.find((rule) => rule.name === name)?.to ?? ""),
        ) ?? ""
      const run = runOfEvent(num(event, "id") ?? 0)
      return {
        kind: "event" as const,
        id: num(event, "id") ?? 0,
        title: text(event, "type") ?? "",
        summary: text(event, "summary") ?? "",
        rule: String(ruleName),
        lane: text(run, "lane") ?? "",
        at: text(event, "received_at") ?? "",
      }
    })
  const cardItems: MissedItem[] = rowsOf(view, "cards")
    .map(({ data }) => data)
    .filter((card) => {
      if (card["kind"] !== "ask" || card["state"] !== "open") return false
      const at = Date.parse(text(card, "created_at") ?? "")
      if (Number.isNaN(at) || at < windowStart || at > now) return false
      const rule = rules.rules.find((known) => known.name === text(card, "rule"))
      // Открытый вопрос в треде воркера — пропущенное внимание, кто бы его
      // ни задал: свой неотвеченный вопрос — тоже контекст возвращения.
      return rule !== undefined && agents.has(rule.to)
    })
    .map((card) => ({
      kind: "card" as const,
      id: num(card, "id") ?? 0,
      title: text(card, "title") ?? "",
      summary: text(card, "text") ?? "",
      rule: text(card, "rule") ?? "",
      lane: text(card, "lane") ?? "",
      at: text(card, "created_at") ?? "",
    }))
  const dropped = rowsOf(view, "events")
    .map(({ data }) => data)
    .filter((event) => {
      const at = Date.parse(text(event, "received_at") ?? "")
      if (Number.isNaN(at) || at < (Number.isNaN(seenAt) ? 0 : seenAt) || at >= windowStart) return false
      const routed = (event["routed"] as Array<unknown> | undefined) ?? []
      return routed.some(
        (ruleName) =>
          typeof ruleName === "string" && agents.has(rules.rules.find((rule) => rule.name === ruleName)?.to ?? ""),
      )
    }).length
  const droppedCards = rowsOf(view, "cards")
    .map(({ data }) => data)
    .filter((card) => {
      if (card["kind"] !== "ask" || card["state"] !== "open") return false
      const at = Date.parse(text(card, "created_at") ?? "")
      if (Number.isNaN(at) || at < (Number.isNaN(seenAt) ? 0 : seenAt) || at >= windowStart) return false
      const rule = rules.rules.find((known) => known.name === text(card, "rule"))
      return rule !== undefined && agents.has(rule.to)
    }).length
  const missed = [...eventItems, ...cardItems]
    .sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id)
    .slice(0, REPLAY_MAX_ITEMS)
  return {
    worker,
    since: new Date(windowStart).toISOString(),
    until: new Date(now).toISOString(),
    missed,
    droppedOlderThan24h: dropped + droppedCards,
    truncated: eventItems.length + cardItems.length > REPLAY_MAX_ITEMS,
  }
}
