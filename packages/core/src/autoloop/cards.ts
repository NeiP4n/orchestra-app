export * as AutoloopCards from "./cards.js"

import { AutoloopCard } from "@orchestra/schema/autoloop-card"
import type { Event } from "@orchestra/schema/event"
import { Effect, Schema } from "effect"
import { decide, type AutoloopLimits, type CardRow, type DecideInput } from "./kernel/decide.js"
import type { DisputeLevel } from "./kernel/dispute.js"
import type { AutonomyMode } from "./kernel/autonomy.js"
import type { View } from "./kernel/evolve.js"
import { rows } from "./kernel/evolve.js"
import { emptyRules, type Rules } from "./kernel/rules.js"
import { AutoloopStore, StaleSeqError, type OpenedView } from "./kernel/store.js"

// Cards ask/notice (block Б3, подшаг 2): the thin layer over the journal
// (`store`) and the pure decision (`decide`). This is the ONLY place the
// API and the SSE stream read and answer cards from — `question` /
// `interact` stay as UI, the card in the journal is the source of truth.
// Answering a card writes the fact and commits it; the cycle itself is
// never stopped — only this card waits for its answer, other runs go on.
// The tick/service and the orchestrator wiring are later Б3 sub-steps;
// they drive `nextCard` / `markDelivered` / `markFailed` from here.

export type Card = typeof AutoloopCard.Card.Type

/** What the caller passes in: rules from Orchestra config, limits, secrets, clock. */
export interface CardsEnv {
  /** Cycle rules; when absent, the rules stored in the journal are used, else none. */
  rules?: Rules
  /** Cycle limits; anything missing falls back to `decide`'s defaults. */
  limits?: Partial<AutoloopLimits>
  /**
   * Autonomy mode (`off` / `observe` / `auto`); when absent the kernel
   * runs as before (`auto`).
   */
  autonomy?: AutonomyMode
  /** Secret the claim/finish tokens are derived from (credential store). */
  tokenSecret?: string
  /** Clock override, for tests: the service passes nothing and gets real time. */
  now?: number
}

/** What changed about a card: for the SSE stream. */
export type CardChangeType = "created" | "answered" | "updated"
export interface CardChange {
  type: CardChangeType
  card: Card
}

/** The narrow half of the bus the cards need: anything that can publish an event. */
export interface CardPublisher {
  publish: <D extends Event.Definition>(definition: D, data: Event.Data<D>) => Effect.Effect<Event.Payload<D>>
}

export class CardsFailure extends Schema.TaggedError<CardsFailure>()("Autoloop.CardsFailure", {
  code: Schema.Literals(["not-found", "invalid", "conflict", "forbidden", "unavailable"]),
  message: Schema.String,
}) {}

/** A store failure is not a bad card: the journal is unavailable, so the API is too. */
const storeFailure = (cause: unknown): CardsFailure =>
  cause instanceof CardsFailure
    ? cause
    : new CardsFailure({
        code: "unavailable",
        message: cause instanceof Error ? cause.message : "журнал недоступен",
      })

export interface CreateCardInput {
  key: string
  kind?: "ask" | "notice"
  title: string
  text?: string
  options?: string[]
  recommend?: string | null
  about?: string
}

export interface AnswerCardInput {
  choice?: number
  text?: string
  by?: string
}

/** A card row as the journal stores it, in the public shape. */
export function toCard(row: CardRow): Card {
  // The journal stores rows as JSON, which drops `undefined` keys — a card
  // created without a recommendation has no `recommend` key at all. Treat a
  // missing nullable field as null, never as a decode failure.
  return Schema.decodeUnknownSync(AutoloopCard.Card)({
    id: row.id,
    key: row.key,
    kind: row.kind,
    title: row.title,
    text: row.text ?? "",
    options: row.options ?? [],
    recommend: row.recommend ?? null,
    about: row.about ?? "",
    state: row.state,
    choice: row.choice ?? null,
    answer: row.answer ?? null,
    by: row.by ?? null,
    runId: row.run_id ?? null,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? null,
    closedAt: row.closed_at ?? null,
  })
}

const cardRows = (view: View): CardRow[] =>
  rows(view, "cards")
    .map(({ data }) => data as CardRow)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)

/** All cards, oldest first. */
export const allCards = (view: View): Card[] => cardRows(view).map(toCard)

/** Open cards only, oldest first — the ones a human still owes an answer to. */
export const openCards = (view: View): Card[] => allCards(view).filter((card) => card.state === "open")

export const cardById = (view: View, id: number): Card | undefined => allCards(view).find((card) => card.id === id)

const decideError = (cause: unknown): CardsFailure => {
  const code = (cause as { code?: unknown } | null)?.code
  const message = cause instanceof Error ? cause.message : String(cause)
  if (code === "Autoloop.DecideNotFound") return new CardsFailure({ code: "not-found", message })
  if (code === "Autoloop.DecideAuth") return new CardsFailure({ code: "forbidden", message })
  if (code === "Autoloop.DecideConflict") return new CardsFailure({ code: "conflict", message })
  return new CardsFailure({ code: "invalid", message })
}

/** Rules stored in the journal by a `rules` decide input, if any — the service reads them the same way. */
export const storedRules = (view: View): { rules: Rules; version: number } | undefined => {
  const stored = view["config"]?.["rules"]
  if (typeof stored !== "object" || stored === null) return undefined
  const value = (stored as Record<string, unknown>)["value"]
  const version = (stored as Record<string, unknown>)["version"]
  if (typeof value !== "object" || value === null || !Array.isArray((value as Record<string, unknown>)["rules"])) {
    return undefined
  }
  return { rules: value as Rules, version: typeof version === "number" ? version : 0 }
}

const decideEnv = (view: View, lastSeq: number, env?: CardsEnv) => {
  const stored = storedRules(view)
  return {
    rules: env?.rules ?? stored?.rules ?? emptyRules(),
    limits: env?.limits,
    autonomy: env?.autonomy,
    tokenSecret: env?.tokenSecret,
    seq: lastSeq + 1,
    rulesVersion: stored?.version ?? 1,
  }
}

const runDecide = (view: View, lastSeq: number, input: DecideInput, env?: CardsEnv) =>
  Effect.try({
    try: () => decide(view, input, env?.now ?? Date.now(), decideEnv(view, lastSeq, env)),
    catch: (cause) => decideError(cause),
  })

/** What changed about cards between two views: for the SSE stream and the tick service. */
export const cardChanges = (before: View, after: View): CardChange[] => {
  const oldCards = new Map(cardRows(before).map((row) => [row.id, row]))
  return cardRows(after).flatMap((row): CardChange[] => {
    const old = oldCards.get(row.id)
    if (old === undefined) return [{ type: "created" as const, card: toCard(row) }]
    if (JSON.stringify(old) === JSON.stringify(row)) return []
    if (old.state === "open" && row.state === "decided") {
      return [{ type: "answered" as const, card: toCard(row) }]
    }
    return [{ type: "updated" as const, card: toCard(row) }]
  })
}

const commitDecided = (opened: OpenedView, input: DecideInput, env?: CardsEnv) =>
  Effect.gen(function* () {
    const decided = yield* runDecide(opened.view, opened.lastSeq, input, env)
    if (decided.facts.length === 0) return { view: opened.view, events: [] as CardChange[], value: decided.value }
    return yield* AutoloopStore.commit(decided.facts, opened.lastSeq).pipe(
      Effect.map((committed) => ({
        view: committed.view,
        events: cardChanges(opened.view, committed.view),
        value: decided.value,
      })),
      // Two answers racing: the loser's commit fails on the stale sequence
      // instead of silently overwriting the winner. It re-decides on the
      // fresh view once — an already-decided card then answers
      // `changed: false` instead of recording a second answer (M-05).
      // `catch` + `instanceof`, not `catchTag`: the store's error
      // channel carries no tag union for the tag to match against.
      Effect.catch((error) =>
        error instanceof StaleSeqError
          ? Effect.gen(function* () {
              const reopened = yield* openJournal
              const redecided = yield* runDecide(reopened.view, reopened.lastSeq, input, env)
              if (redecided.facts.length === 0) {
                return { view: reopened.view, events: [] as CardChange[], value: redecided.value }
              }
              const recommitted = yield* AutoloopStore.commit(redecided.facts, reopened.lastSeq)
              return {
                view: recommitted.view,
                events: cardChanges(reopened.view, recommitted.view),
                value: redecided.value,
              }
            })
          : Effect.fail(error),
      ),
      Effect.mapError(storeFailure),
    )
  })

const openJournal = AutoloopStore.openView().pipe(Effect.mapError(storeFailure))

const cardOrFail = (view: View, id: number) => {
  const card = cardById(view, id)
  return card === undefined
    ? Effect.fail(new CardsFailure({ code: "not-found", message: "такой карточки нет" }))
    : Effect.succeed(card)
}

/** All cards, oldest first. */
export function listCards() {
  return Effect.gen(function* () {
    const { view } = yield* openJournal
    return allCards(view)
  })
}

/** Open cards only, oldest first. */
export function listOpenCards() {
  return Effect.map(listCards(), (cards) => cards.filter((card) => card.state === "open"))
}

/**
 * Create a card. The same key while the card is open returns the existing
 * card instead of a duplicate — `duplicate: true`, no new fact.
 */
export function createCard(spec: CreateCardInput, env?: CardsEnv) {
  return Effect.gen(function* () {
    const opened = yield* openJournal
    const { view, events, value } = yield* commitDecided(opened, { type: "createCard", args: [spec] }, env)
    const created = value as { card: number; duplicate: boolean }
    const card = yield* cardOrFail(view, created.card)
    return { card, duplicate: created.duplicate, events }
  })
}

/**
 * Answer a card. An ask answer records `card.answered` (with the chosen
 * option in the event's detail) and starts a new round when the card belongs
 * to a rule; a notice answer just closes it. Answering `Отменить задачу`
 * cancels the task instead and starts no round. `newRunId` is the run the
 * answer started, or null when none started.
 */
export function answerCard(id: number, input: AnswerCardInput, env?: CardsEnv) {
  return Effect.gen(function* () {
    const opened = yield* openJournal
    yield* cardOrFail(opened.view, id)
    const { view, events, value } = yield* commitDecided(opened, { type: "answer", args: [id, input] }, env)
    const answered = value as { changed: boolean; state: string }
    const card = yield* cardOrFail(view, id)
    const row = cardRows(view).find((candidate) => candidate.id === id)
    const answerEvent = row?.answer_event ?? null
    const newRunId =
      answerEvent === null
        ? null
        : ((rows(view, "run_events").find(({ data }) => data["event_id"] === answerEvent)?.data["run_id"] as
            | number
            | undefined) ?? null)
    return { card, changed: answered.changed, newRunId, events }
  })
}

/**
 * Hand the next card out to a channel (`web`, `tui`, ...), honouring the
 * resend schedule: a card already handed out rests a minute, a failed send
 * comes back at the next `RESEND_AT` step, and after 57 minutes the channel
 * gives up. The delivery loop (a later B3 sub-step) drives this.
 */
export function nextCard(channel: string, env?: CardsEnv) {
  return Effect.gen(function* () {
    const opened = yield* openJournal
    const { view, value } = yield* commitDecided(opened, { type: "nextCard", args: [channel] }, env)
    const handed = value as { id: number } | null
    if (handed === null) return { card: null as Card | null }
    return { card: yield* cardOrFail(view, handed.id) }
  })
}

/** A channel delivered the card: stop resending it until it changes. */
export function markDelivered(channel: string, id: number, version: number, ref: string | null, env?: CardsEnv) {
  return Effect.gen(function* () {
    const opened = yield* openJournal
    const { view } = yield* commitDecided(opened, { type: "delivered", args: [channel, id, version, ref] }, env)
    return { card: yield* cardOrFail(view, id) }
  })
}

/** A channel failed to deliver the card: schedule the next resend. */
export function markFailed(channel: string, id: number, version: number, error: string, env?: CardsEnv) {
  return Effect.gen(function* () {
    const opened = yield* openJournal
    const { view } = yield* commitDecided(opened, { type: "failed", args: [channel, id, version, error] }, env)
    return { card: yield* cardOrFail(view, id) }
  })
}

/** What raising a dispute takes: two positions and the level it starts at. */
export interface RaiseDisputeInput {
  subject: string
  positionA: string
  positionB: string
  level?: "agent" | "group-leader" | "council" | "orchestrator" | "operator"
}

/**
 * Raise a dispute on the timed ladder: it opens at the given level (or
 * `agent`), climbs one rung when its deadline passes (the clock wakes on
 * the due — see `deadlines`), and reaches the operator as a note, never
 * blocking work. This is the ladder's entry point: before it, `raiseDispute`
 * in the kernel had no callers at all (M-03).
 */
export function raiseDispute(input: RaiseDisputeInput, env?: CardsEnv) {
  return Effect.gen(function* () {
    const opened = yield* openJournal
    const { value } = yield* commitDecided(
      opened,
      { type: "raiseDispute", args: [input.subject, input.positionA, input.positionB, input.level] },
      env,
    )
    return value as { dispute: number; level: DisputeLevel; deadline: string }
  })
}

/** Resolve an open dispute with a decision: it stops climbing. */
export function resolveDispute(id: number, decision: string, env?: CardsEnv) {
  return Effect.gen(function* () {
    const opened = yield* openJournal
    const { value } = yield* commitDecided(opened, { type: "resolveDispute", args: [id, decision] }, env)
    return { resolved: value as boolean }
  })
}

/** Move an open dispute up one rung now, without waiting for its deadline. */
export function escalateDispute(id: number, env?: CardsEnv) {
  return Effect.gen(function* () {
    const opened = yield* openJournal
    const { value } = yield* commitDecided(opened, { type: "escalateDispute", args: [id] }, env)
    return value as { escalated: boolean; reason: string; level: DisputeLevel; state: string }
  })
}

/** Publish what changed about cards, so the SSE stream can tell the human. */
export function publish(publisher: CardPublisher, events: ReadonlyArray<CardChange>) {
  return Effect.gen(function* () {
    for (const event of events) {
      if (event.type === "created") yield* publisher.publish(AutoloopCard.Event.Created, { card: event.card })
      else if (event.type === "answered") yield* publisher.publish(AutoloopCard.Event.Answered, { card: event.card })
      else yield* publisher.publish(AutoloopCard.Event.Updated, { card: event.card })
    }
  })
}
