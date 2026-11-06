export * as AutoloopDecide from "./decide.js"

import { createHash } from "node:crypto"
import {
  MINUTE,
  SEEN_EVERY,
  deadlines,
  offlineCard,
  waitingOn,
  workerOfRun,
  workers,
} from "./due.js"
import type { DueLimits } from "./due.js"
import type { View } from "./evolve.js"
import { iso } from "./evolve.js"
import { SCHEDULE, cronOf, eventRule, typeMatches } from "./rules.js"
import type { Rule, Rules } from "./rules.js"
import type { AutoloopFact } from "./schema.js"

// Pure decisions (block B3). Port of agent-autoloop's kernel/decide.ts:
// everything that can change the cycle is decided here — given the view and
// one input, the facts to record and the answer to give. Time and secrets
// come in as arguments, so the same input on the same view always decides
// the same. No Effect inside, no I/O: the service (a later B3 sub-step)
// reads the view, calls `decide`, and commits the facts with store.commit.
//
// Orchestra limits (config `autoloop` in packages/schema/src/config/
// orchestra.ts) replace the original ones: at most 1–2 retries instead of
// 10, at most 5 verification rounds, `MAX_HOPS = 8`, a 5-minute run lease.
// Card delivery keeps the original schedule: resends at 0, 1, 3, 7, 15, 25,
// 35, 45, 55 minutes, given up after 57 minutes.

/** Minutes after the first try that a card is sent to a channel again. */
export const RESEND_AT = [0, 1, 3, 7, 15, 25, 35, 45, 55]

/** The last resend and the minute it holds the card: after this a channel has given up. */
export const RESEND_WINDOW = 57 * MINUTE

/** Answer/author and delivery reference length caps, mirroring the original protocol limits. */
export const ANSWER_BY = 100
export const ANSWER_REF = 200
export const ANSWER_TEXT = 2000
export const DELIVERY_REF = 200

/**
 * The ask-card option that ends the task instead of starting a new round.
 * The only card that offers it is the "check keeps failing" card in
 * `applyReceipt`; `answer` matches on this exact text, so renaming the
 * option there must rename it here too.
 */
export const CANCEL_OPTION = "Отменить задачу"

/** Cycle limits. Numbers live in the Orchestra config; these are the defaults. */
export interface AutoloopLimits {
  /** Failed-run retries before the run stops (original: 10). */
  maxAttempts: number
  /** Check-fix rounds before the run stops and asks a human (new in Orchestra). */
  maxVerifyIterations: number
  /** How deep a chain of events causing events may get before it stops. */
  maxHops: number
  /** First retry pause, minutes; doubles per attempt up to `retryMaxMinutes`. */
  retryBaseMinutes: number
  /** Retry pause cap, minutes. */
  retryMaxMinutes: number
  /** How long a claimed run can go unmentioned before it's in doubt, minutes. */
  runLeaseMinutes: number
  /** A worker seen this recently counts as present, minutes. */
  workerFreshMinutes: number
  /** How long work waits on a silent worker before the owner hears, minutes. */
  offlineAfterMinutes: number
}

export const DEFAULT_LIMITS: AutoloopLimits = {
  maxAttempts: 2,
  maxVerifyIterations: 5,
  maxHops: 8,
  retryBaseMinutes: 5,
  retryMaxMinutes: 60,
  runLeaseMinutes: 5,
  workerFreshMinutes: 2,
  offlineAfterMinutes: 10,
}

export const resolveLimits = (given?: Partial<AutoloopLimits>): AutoloopLimits => ({
  maxAttempts: Math.max(1, given?.maxAttempts ?? DEFAULT_LIMITS.maxAttempts),
  maxVerifyIterations: Math.max(1, given?.maxVerifyIterations ?? DEFAULT_LIMITS.maxVerifyIterations),
  maxHops: Math.max(0, given?.maxHops ?? DEFAULT_LIMITS.maxHops),
  retryBaseMinutes: Math.max(1, given?.retryBaseMinutes ?? DEFAULT_LIMITS.retryBaseMinutes),
  retryMaxMinutes: Math.max(1, given?.retryMaxMinutes ?? DEFAULT_LIMITS.retryMaxMinutes),
  runLeaseMinutes: Math.max(1, given?.runLeaseMinutes ?? DEFAULT_LIMITS.runLeaseMinutes),
  workerFreshMinutes: Math.max(1, given?.workerFreshMinutes ?? DEFAULT_LIMITS.workerFreshMinutes),
  offlineAfterMinutes: Math.max(1, given?.offlineAfterMinutes ?? DEFAULT_LIMITS.offlineAfterMinutes),
})

const dueLimitsOf = (limits: AutoloopLimits): DueLimits => ({
  runLeaseMs: limits.runLeaseMinutes * MINUTE,
  workerFreshMs: limits.workerFreshMinutes * MINUTE,
  offlineAfterMs: limits.offlineAfterMinutes * MINUTE,
})

export class DecideInputError extends Error {
  readonly code = "Autoloop.DecideInput"
  constructor(message: string) {
    super(message)
    this.name = "DecideInputError"
  }
}

export class DecideNotFoundError extends Error {
  readonly code = "Autoloop.DecideNotFound"
  constructor(message: string) {
    super(message)
    this.name = "DecideNotFoundError"
  }
}

export class DecideAuthError extends Error {
  readonly code = "Autoloop.DecideAuth"
  constructor(message: string) {
    super(message)
    this.name = "DecideAuthError"
  }
}

export class DecideConflictError extends Error {
  readonly code = "Autoloop.DecideConflict"
  constructor(message: string) {
    super(message)
    this.name = "DecideConflictError"
  }
}

export type RunState = "queued" | "claimed" | "done" | "nothing" | "failed" | "cancelled" | "unknown"
export type ReceiptOutcome = "done" | "nothing" | "failed" | "cancelled"

/** One projection row, as stored in the view: plain JSON data. */
export type RowData = Record<string, unknown>

export interface RunRow extends RowData {
  id: number
  rule: string
  agent: string
  grp: string
  lane: string
  state: RunState
  attempts: number
  verifyIterations: number
  claim: string | null
  issued: number | null
  last_issued: number | null
  last_result: string | null
  last_answer: string | null
  cancel_at: string | null
  resume: string | null
  session: string | null
  link: string | null
  claimed_at: string | null
  seen_at: string | null
  finished_at: string | null
  summary: string | null
  error: string | null
  usage: Record<string, unknown> | null
  not_before: string
  created_at: string
  rules_version: number
}

export interface EventRow extends RowData {
  id: number
  source: string
  key: string
  type: string
  subject: string
  summary: string
  detail: string
  link: string
  hops: number
  routed: string[]
  received_at: string
}

export interface CardRow extends RowData {
  id: number
  key: string
  kind: "ask" | "notice"
  title: string
  text: string
  options: string[]
  recommend: string | null
  about: string
  state: "open" | "closed" | "decided" | "done"
  fyi: number
  quiet: number
  hops: number
  choice: number | null
  answer: string | null
  by: string | null
  result: string | null
  rule: string | null
  lane: string
  grp: string | null
  source: string | null
  agent: string | null
  session: string | null
  run_id: number | null
  answer_event: number | null
  version: number
  created_at: string
  decided_at: string | null
  closed_at: string | null
}

export interface DeliveryRow extends RowData {
  card_id: number
  channel: string
  version: number
  ref: string | null
  tries: number
  first_try_at: string | null
  not_before: string | null
  error: string | null
  given_up: number
}

export interface TimerRow extends RowData {
  id: number
  rule: string
  lane: string
  key: string
  source: string
  at: string
  about: string
  session: string | null
  hops: number
  event_id: number | null
  created_at: string
}

export interface ScheduleRow extends RowData {
  rule: string
  cron: string
  next_at: string
}

/** What the service passes in: rules from Orchestra config, limits, secrets. */
export interface DecideEnv {
  /** Rules, built from Orchestra config — never from a rules.json file. */
  rules: Rules
  /** Cycle limits; anything missing falls back to `DEFAULT_LIMITS`. */
  limits?: Partial<AutoloopLimits>
  /** Secret the claim/finish tokens are derived from (credential store). */
  tokenSecret?: string
  /** Sequence number this decision will be committed as (lastSeq + 1). */
  seq?: number
  /** Version of the rule set the runs were queued under. */
  rulesVersion?: number
}

export interface DecideInput {
  type: string
  args: Array<unknown>
}

export interface DecideResult {
  facts: AutoloopFact[]
  value: unknown
}

/** A job handed to a worker that claimed a run. */
export interface Job {
  run: number
  rule: string
  agent: string
  cwd: string
  group: string
  lane: string
  session: string | null
  resume: string | null
  token: string
  events: EventRow[]
}

/** An incoming event, as validated by `parseEvent`. */
export interface EventInput {
  id: string
  type: string
  subject: string
  summary: string
  detail: string
  link: string
  hops: number
}

/** A card a worker asks to create, as validated by `parseCardSpec`. */
export interface CardSpec {
  key: string
  kind?: "ask" | "notice"
  title: string
  text: string
  options?: string[]
  recommend?: string | null
  about?: string
  fyi?: boolean
  quiet?: boolean
  once?: boolean
  run?: number
  lane?: string
  grp?: string
  source?: string
  agent?: string
  session?: string | null
  hops?: number
}

export interface Later {
  key: string
  at?: string
  about?: string
  cancel?: boolean
}

/** A worker's receipt: strictly one outcome plus its lists. */
export interface Receipt {
  outcome: ReceiptOutcome
  summary?: string
  error?: string
  session?: string
  usage?: Record<string, number>
  ask?: CardSpec[]
  notice?: CardSpec[]
  resolve?: Array<{ card: number; reason: string }>
  later?: Later[]
  events?: EventInput[]
  /** The run finished, but the code check (DoD) failed: another fix round. */
  verifyFailed?: boolean
}

export interface Rejected {
  what?: string
  card?: number
  reason: string
}

type Change = { collection: string; key: string; data: RowData | null }

/** One input being decided: what holds throughout, and the view with its changes so far. */
export interface Draft {
  view: View
  changes: Change[]
  seq: number
  now: number
  at: string
  env: DecideEnv
  rules: Rules
  limits: AutoloopLimits
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex")

/** The token a worker finishes a run with: derived from the run and its issue, so a lost answer replays safely. */
const tokenFor = (secret: string, runId: number, issued: number): string =>
  createHash("sha256").update(`${secret}:run:${runId}:${issued}`).digest("hex").slice(0, 32)

const cloneView = (view: View): View => JSON.parse(JSON.stringify(view)) as View

const dataOf = (view: View, collection: string, key: string | number): RowData | undefined => {
  const row = view[collection]?.[String(key)]
  return typeof row === "object" && row !== null ? (row as RowData) : undefined
}

const getRow = <T extends RowData>(view: View, collection: string, key: string | number): T | undefined =>
  dataOf(view, collection, key) as T | undefined

const rowsOf = (view: View, collection: string): Array<{ key: string; data: RowData }> =>
  Object.entries(view[collection] ?? {})
    .map(([key, data]) => ({ key, data: data as RowData }))
    .sort((a, b) => {
      const na = Number(a.key)
      const nb = Number(b.key)
      if (Number.isInteger(na) && Number.isInteger(nb)) return na - nb
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    })

const str = (row: RowData | undefined, field: string): string | undefined =>
  typeof row?.[field] === "string" ? (row[field] as string) : undefined

const isRecord = (value: unknown): value is RowData => typeof value === "object" && value !== null && !Array.isArray(value)

const needStr = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new DecideInputError(`${what} — непустая строка`)
  return value
}

const needNum = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new DecideInputError(`${what} — целое число`)
  return value
}

const optStr = (value: unknown, what: string, max: number): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || value.length > max) throw new DecideInputError(`${what} — строка до ${max} знаков`)
  return value
}

const optText = (value: unknown, what: string, max: number, fallback = ""): string => {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "string" || value.length > max) throw new DecideInputError(`${what} — строка до ${max} знаков`)
  return value
}

/** Validate an incoming event: id and type are required, the rest default. */
export function parseEvent(given: unknown): EventInput {
  if (!isRecord(given)) throw new DecideInputError("событие — объект с id и type")
  const id = needStr(given["id"], "событие.id")
  const type = needStr(given["type"], "событие.type")
  if (id.length > 200 || type.length > 200) throw new DecideInputError("событие.id и событие.type — до 200 знаков")
  const hops = given["hops"]
  if (hops !== undefined && (typeof hops !== "number" || !Number.isInteger(hops) || hops < 0)) {
    throw new DecideInputError("событие.hops — целое число от 0")
  }
  return {
    id,
    type,
    subject: optText(given["subject"], "событие.subject", 500),
    summary: optText(given["summary"], "событие.summary", 2000),
    detail: optText(given["detail"], "событие.detail", 2000),
    link: optText(given["link"], "событие.link", 500),
    hops: hops ?? 0,
  }
}

const parseCardSpec = (given: unknown, what: string): CardSpec => {
  if (!isRecord(given)) throw new DecideInputError(`${what} — объект с key, title и text`)
  const key = needStr(given["key"], `${what}.key`)
  const title = needStr(given["title"], `${what}.title`)
  const text = optText(given["text"], `${what}.text`, 2000)
  const options = given["options"]
  if (options !== undefined && (!Array.isArray(options) || options.some((option) => typeof option !== "string"))) {
    throw new DecideInputError(`${what}.options — список строк`)
  }
  return {
    key,
    title,
    text,
    options: options as string[] | undefined,
    recommend: optStr(given["recommend"], `${what}.recommend`, 200),
    about: optText(given["about"], `${what}.about`, 500),
    fyi: given["fyi"] === true,
    quiet: given["quiet"] === true,
    once: given["once"] === true,
  }
}

/** Validate a worker's receipt: strictly one outcome, known lists, sane sizes. */
export function parseResult(given: unknown): Receipt {
  if (!isRecord(given)) throw new DecideInputError("квитанция — объект с outcome")
  const outcome = given["outcome"]
  if (outcome !== "done" && outcome !== "nothing" && outcome !== "failed" && outcome !== "cancelled") {
    throw new DecideInputError("квитанция.outcome — done, nothing, failed или cancelled")
  }
  const usage = given["usage"]
  if (usage !== undefined && (!isRecord(usage) || Object.values(usage).some((value) => typeof value !== "number"))) {
    throw new DecideInputError("квитанция.usage — объект с числами")
  }
  const resolve = given["resolve"]
  if (resolve !== undefined) {
    if (!Array.isArray(resolve)) throw new DecideInputError("квитанция.resolve — список")
    for (const item of resolve) {
      if (!isRecord(item) || typeof item["card"] !== "number" || typeof item["reason"] !== "string") {
        throw new DecideInputError("квитанция.resolve — список { card, reason }")
      }
    }
  }
  const later = given["later"]
  if (later !== undefined) {
    if (!Array.isArray(later)) throw new DecideInputError("квитанция.later — список")
    for (const item of later) {
      if (!isRecord(item) || typeof item["key"] !== "string") throw new DecideInputError("квитанция.later — список { key, at }")
      if (item["cancel"] !== true && (typeof item["at"] !== "string" || Number.isNaN(Date.parse(item["at"])))) {
        throw new DecideInputError("квитанция.later.at — время в формате ISO")
      }
    }
  }
  return {
    outcome,
    summary: optText(given["summary"], "квитанция.summary", 2000),
    error: optText(given["error"], "квитанция.error", 2000),
    session: optStr(given["session"], "квитанция.session", 500),
    usage: usage as Record<string, number> | undefined,
    ask: Array.isArray(given["ask"]) ? given["ask"].map((card) => parseCardSpec(card, "квитанция.ask")) : undefined,
    notice: Array.isArray(given["notice"])
      ? given["notice"].map((card) => parseCardSpec(card, "квитанция.notice"))
      : undefined,
    resolve: resolve as Array<{ card: number; reason: string }> | undefined,
    later: later as Later[] | undefined,
    events: Array.isArray(given["events"]) ? given["events"].map((event) => parseEvent(event)) : undefined,
    verifyFailed: given["verifyFailed"] === true,
  }
}

const RUN_DEFAULTS: Partial<RunRow> = {
  attempts: 0,
  verifyIterations: 0,
  claim: null,
  issued: null,
  last_issued: null,
  last_result: null,
  last_answer: null,
  cancel_at: null,
  resume: null,
  session: null,
  link: null,
  claimed_at: null,
  seen_at: null,
  finished_at: null,
  summary: null,
  error: null,
  usage: null,
}

const CARD_DEFAULTS: Partial<CardRow> = {
  text: "",
  options: [],
  recommend: null,
  about: "",
  state: "open",
  fyi: 0,
  quiet: 0,
  hops: 0,
  choice: null,
  answer: null,
  by: null,
  result: null,
  rule: null,
  lane: "",
  grp: null,
  source: null,
  agent: null,
  session: null,
  run_id: null,
  answer_event: null,
  version: 1,
  decided_at: null,
  closed_at: null,
}

const DELIVERY_DEFAULTS: Partial<DeliveryRow> = {
  version: 0,
  ref: null,
  tries: 0,
  first_try_at: null,
  not_before: null,
  error: null,
  given_up: 0,
}

const nulls = (...names: string[]): RowData => Object.fromEntries(names.map((name) => [name, null]))

function set(draft: Draft, collection: string, key: string | number, row: RowData | null): RowData | null {
  const keyText = String(key)
  draft.changes.push({ collection, key: keyText, data: row })
  if (row === null) {
    delete draft.view[collection]?.[keyText]
    if (draft.view[collection] !== undefined && Object.keys(draft.view[collection]!).length === 0) {
      delete draft.view[collection]
    }
    return null
  }
  draft.view[collection] ??= {}
  draft.view[collection]![keyText] = row
  return row
}

const defaultsOf = (collection: string): RowData => {
  if (collection === "runs") return { ...RUN_DEFAULTS }
  if (collection === "cards") return { ...CARD_DEFAULTS }
  if (collection === "deliveries") return { ...DELIVERY_DEFAULTS }
  return {}
}

const put = (draft: Draft, collection: string, key: string | number, fields: RowData): RowData =>
  set(draft, collection, key, {
    ...defaultsOf(collection),
    ...dataOf(draft.view, collection, key),
    ...fields,
  })!

const nextId = (draft: Draft, collection: string): number => {
  const ids = rowsOf(draft.view, collection).map(({ key }) => Number(key)).filter((id) => Number.isInteger(id))
  return (ids.length === 0 ? 0 : Math.max(...ids)) + 1
}

function add<T extends RowData>(draft: Draft, collection: string, fields: RowData): T {
  const id = nextId(draft, collection)
  put(draft, collection, id, { ...fields, id })
  return getRow<T>(draft.view, collection, id)!
}

export function decide(view: View, input: DecideInput, now: number, env: DecideEnv): DecideResult {
  const handler = HANDLERS[input.type]
  if (handler === undefined) throw new DecideInputError(`неизвестный вход: ${input.type}`)
  const limits = resolveLimits(env.limits)
  const draft: Draft = {
    view: cloneView(view),
    changes: [],
    seq: env.seq ?? 0,
    now,
    at: iso(new Date(now)),
    env,
    rules: env.rules,
    limits,
  }
  const value = handler(draft, ...input.args)

  // With nothing changed nothing new can come due, and what only the clock
  // changes has a deadline of its own to bring a tick.
  if (draft.changes.length === 0 && input.type !== "tick") return { facts: [], value }

  const due = deadlines(draft.view, now, draft.rules, dueLimitsOf(limits))
  for (const [key, row] of Object.entries(due)) {
    if (JSON.stringify(dataOf(draft.view, "due", key) ?? null) !== JSON.stringify(row)) {
      put(draft, "due", key, { kind: row.kind, key: row.key, at: row.at })
    }
  }
  for (const { key } of rowsOf(draft.view, "due")) {
    if (due[key] === undefined) set(draft, "due", key, null)
  }

  const facts = draft.changes.map((change, index) => ({
    id: `decide:${input.type}:${now}:${index}:${digest(JSON.stringify(change)).slice(0, 8)}`,
    type: `autoloop.${input.type}`,
    collection: change.collection,
    key: change.key,
    data: change.data,
    time: now,
  }))
  return { facts, value }
}

const ruleNamed = (draft: Draft, name: string): Rule | undefined =>
  draft.rules.rules.find((rule) => rule.name === name)

function assignQueued(draft: Draft, run: RunRow) {
  const rule = ruleNamed(draft, run.rule)
  if (rule === undefined) return
  const session = rule.to === run.agent ? {} : nulls("session", "resume")
  put(draft, "runs", run.id, { agent: rule.to, rules_version: draft.env.rulesVersion ?? 0, ...session })
}

const threadOf = (run: RunRow) => ({ rule: run.rule, lane: run.lane, grp: run.grp })

/** The session a round about to start goes on in. With resume, one that has none takes its thread's last, unless that round was stopped. */
function settleSession(draft: Draft, run: RunRow) {
  const rule = ruleNamed(draft, run.rule)
  const thread = { rule: run.rule, lane: run.lane }
  const carried = run.session ?? run.resume
  let session = carried
  if (session === null && rule?.resume === true) {
    const done = rowsOf(draft.view, "runs")
      .map(({ data }) => data as RunRow)
      .filter(
        (other) =>
          other.rule === thread.rule &&
          other.lane === thread.lane &&
          (other.state === "done" || other.state === "nothing" || other.state === "cancelled"),
      )
      .sort((a, b) => b.id - a.id)[0]
    if (done !== undefined && done.state !== "cancelled" && done.agent === rule.to) session = done.session
  }
  if (session === null) return
  const going = rowsOf(draft.view, "runs")
    .map(({ data }) => data as RunRow)
    .filter((other) => other.rule === thread.rule && other.lane === thread.lane && (other.state === "claimed" || other.state === "unknown"))
  if (going.some((other) => (other.session ?? other.resume) === session)) {
    put(draft, "runs", run.id, nulls("session", "resume"))
  } else if (session !== carried) {
    put(draft, "runs", run.id, { resume: session })
  }
}

const eventsOf = (view: View, runId: number): EventRow[] => {
  const eventIds = rowsOf(view, "run_events")
    .map(({ data }) => data)
    .filter((link) => link["run_id"] === runId)
    .map((link) => link["event_id"] as number)
  return eventIds
    .map((id) => getRow<EventRow>(view, "events", id))
    .filter((event): event is EventRow => event !== undefined)
}

const hopsOf = (draft: Draft, run: RunRow): number =>
  Math.max(0, ...eventsOf(draft.view, run.id).map((event) => event.hops ?? 0))

const sourceOf = (view: View, runId: number): string | undefined => eventsOf(view, runId)[0]?.source

const agentsOf = (draft: Draft, worker: string): string[] =>
  Object.entries(draft.rules.agents)
    .filter(([, agent]) => agent.worker === worker)
    .map(([name]) => name)

function closeCard(draft: Draft, card: CardRow, result: string, by: string | null = null, note: string | null = null) {
  const closed = { state: "closed", closed_at: draft.at, version: card.version + 1 }
  // A note says how a notice was handled, for looking back at later.
  put(draft, "cards", card.id, { ...closed, result, by: by ?? card.by, ...(note !== null ? { answer: note } : {}) })
}

function closeOpen(draft: Draft, matches: (key: string) => boolean, result: string) {
  const open = rowsOf(draft.view, "cards")
    .map(({ data }) => data as CardRow)
    .filter((card) => card.state === "open" && matches(card.key))
  for (const card of open) closeCard(draft, card, result)
}

/** Once it's stopped, nothing should still say it will try again, or that it may still be going. */
const closeStopped = (draft: Draft, run: number, result: string) =>
  closeOpen(draft, (key) => key === `run:${run}:failing` || key === `run:${run}:unknown`, result)

const closeOffline = (draft: Draft, worker: string) =>
  closeOpen(draft, (key) => key.startsWith(`worker:${worker}:offline:`), "снова на связи")

/** Whether a new stamp would tell nothing this one doesn't. One in the future means a clock was set back: it gets redone. */
function justSeen({ now }: Draft, row?: RowData) {
  const age = now - Date.parse(str(row, "seen_at") ?? "")
  return age >= 0 && age < SEEN_EVERY
}

export function createCard(draft: Draft, spec: CardSpec) {
  const existing = rowsOf(draft.view, "cards")
    .map(({ data }) => data as CardRow)
    .filter((card) => card.key === spec.key && (spec.once === true || card.state === "open"))
    .sort((a, b) => b.id - a.id)[0]
  if (existing !== undefined) return { card: existing.id, duplicate: true }
  if (spec.kind === "ask") {
    const options = spec.options ?? []
    if (options.length < 2 || options.length > 5) {
      throw new DecideInputError("карточка ask — от 2 до 5 вариантов ответа")
    }
  }
  const { once, run, options, fyi, quiet, ...fields } = spec
  const stored = {
    kind: spec.kind ?? "ask",
    run_id: run ?? null,
    options: options ?? [],
    fyi: fyi === true ? 1 : 0,
    quiet: quiet === true ? 1 : 0,
  }
  const state = fyi === true ? { state: "closed", closed_at: draft.at } : { state: "open" }
  const card = add<CardRow>(draft, "cards", { ...fields, ...stored, ...state, created_at: draft.at })
  return { card: card.id, duplicate: false }
}

const notify = (draft: Draft, key: string, title: string, text: string, extra: RowData = {}) =>
  createCard(draft, { key, kind: "notice", title, text, ...extra })

/** A queued run of this rule and thread takes the event, so what comes in while it waits is handled together. */
export function enqueue(draft: Draft, rule: Rule, event: number, lane: string, resume?: string | null) {
  const stamps = { not_before: draft.at, created_at: draft.at, rules_version: draft.env.rulesVersion ?? 0 }
  const queued = rowsOf(draft.view, "runs")
    .map(({ data }) => data as RunRow)
    .find((run) => run.rule === rule.name && run.lane === lane && run.state === "queued")
  const run =
    queued ??
    add<RunRow>(draft, "runs", {
      rule: rule.name,
      agent: rule.to,
      grp: rule.group,
      lane,
      state: "queued",
      ...stamps,
    })
  put(draft, "run_events", `${run.id}:${event}`, { run_id: run.id, event_id: event })
  if (resume !== undefined && resume !== null) put(draft, "runs", run.id, { resume })
  return run.id
}

/** Keeps an event under a key of its own: one the hub makes up mustn't collide with one a source sent. */
function recordEvent(
  draft: Draft,
  source: string,
  event: { id: string; type: string; subject?: string; summary?: string; detail?: string; link?: string; hops?: number },
  routed: string[],
): number {
  let key = event.id
  for (let suffix = 1; rowsOf(draft.view, "events").some(({ data }) => data["source"] === source && data["key"] === key); suffix++) {
    key = `${event.id}:${suffix}`
  }
  return add<EventRow>(draft, "events", {
    source,
    key,
    type: event.type,
    subject: event.subject ?? "",
    summary: event.summary ?? "",
    detail: event.detail ?? "",
    link: event.link ?? "",
    hops: event.hops ?? 0,
    routed,
    received_at: draft.at,
  }).id
}

function ingest(draft: Draft, source: string, given: unknown) {
  const event = parseEvent(given)
  const existing = rowsOf(draft.view, "events")
    .map(({ data }) => data as EventRow)
    .find((row) => row.source === source && row.key === event.id)
  if (existing !== undefined) return { event: existing.id, duplicate: true, routed: existing.routed }
  const tooDeep = event.hops > draft.limits.maxHops
  const takes = (rule: Rule) =>
    eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, event.type)
  const matched = tooDeep ? [] : draft.rules.rules.filter(takes)
  const routed = matched.map((rule) => rule.name)
  const id = recordEvent(draft, source, event, routed)
  if (tooDeep) {
    const words = `Одна цепочка обработки уже глубже ${draft.limits.maxHops} шагов, дальше события записаны, но не раздаются.`
    notify(draft, `hops:${source}:${event.id}`, "Цепочка событий остановлена", words, { once: true })
  }
  for (const rule of matched) enqueue(draft, rule, id, rule.parallel !== undefined ? event.subject : "")
  return { event: id, duplicate: false, routed }
}

function cardFromReceipt(draft: Draft, run: RunRow, kind: "ask" | "notice", card: CardSpec) {
  const name = card.key ?? digest(`${card.title}\n${card.text}`).slice(0, 32)
  const session = getRow<RunRow>(draft.view, "runs", run.id)?.session ?? null
  const fyi = kind === "notice" && card.fyi === true
  const quiet = kind === "notice" && ruleNamed(draft, run.rule)?.tell === "never"
  const origin = { source: sourceOf(draft.view, run.id), agent: run.agent, session, run: run.id }
  const key = `thread:${run.rule}:${run.lane}:${name}`
  // Closed as it's made, nothing open stops it coming again: a run trying again says it once.
  if (fyi && rowsOf(draft.view, "cards").some(({ data }) => data["key"] === key && data["run_id"] === run.id)) return
  createCard(draft, { ...card, hops: hopsOf(draft, run), key, kind, fyi, quiet, ...threadOf(run), ...origin })
}

/** Notices what has gone quiet: a worker that stopped coming, a run its worker stopped mentioning. */
function sweep(draft: Draft) {
  const { now, limits } = draft
  for (const worker of workers(draft.view, draft.rules)) {
    const seen = getRow<RowData>(draft.view, "seen", `worker:${worker}`)
    const lastSeen = seen === undefined ? undefined : Date.parse(str(seen, "seen_at") ?? "")
    const fresh = lastSeen !== undefined && now - lastSeen <= limits.workerFreshMinutes * MINUTE
    if (fresh) closeOffline(draft, worker)
    // A run its worker stopped mentioning is in doubt once its lease is out,
    // whether the worker is still around or already gone: before this fix the
    // block below only ran while the worker counted as fresh, so a run of a
    // worker that died for real stayed `claimed` forever and its lane with it.
    const inDoubt = (run: RunRow) =>
      workerOfRun(draft.rules, run.agent) === worker &&
      Date.parse(run.seen_at ?? "") < now - limits.runLeaseMinutes * MINUTE
    for (const run of rowsOf(draft.view, "runs")
      .map(({ data }) => data as RunRow)
      .filter((run) => run.state === "claimed" && inDoubt(run))) {
      put(draft, "runs", run.id, { state: "unknown" })
      const agent = draft.rules.agents[run.agent]?.name ?? run.agent
      const words = `Задачу отдали ${agent}, а ответа нет уже больше 5 минут — неизвестно, сделано или нет. Новые задачи идут как обычно.`
      notify(draft, `run:${run.id}:unknown`, run.rule, words, threadOf(run))
    }
    if (!fresh) {
      // The worker is gone (no heartbeat past `workerFreshMinutes`): what it
      // held is not coming back from it. Send its unknown runs back to the
      // queue — another worker can take them, and the lane is free again.
      // A worker that is alive keeps its unknown runs: it may still finish
      // them, so they are only re-queued while it stays gone.
      for (const run of rowsOf(draft.view, "runs")
        .map(({ data }) => data as RunRow)
        .filter((run) => run.state === "unknown" && inDoubt(run))) {
        put(draft, "runs", run.id, {
          state: "queued",
          not_before: draft.at,
          ...nulls("claim", "claimed_at", "seen_at", "cancel_at"),
        })
        closeOpen(draft, (key) => key === `run:${run.id}:unknown`, "возвращена в очередь: исполнитель не на связи")
      }
    }
    const waiting = waitingOn(draft.view, worker, draft.rules)
    if (waiting.length === 0) continue
    const since = now - (lastSeen ?? Date.parse(str(waiting[0], "created_at") ?? ""))
    const { key, told } = offlineCard(draft.view, worker, waiting)
    if (since <= limits.offlineAfterMinutes * MINUTE || told) continue
    const minutes = Math.floor(since / MINUTE)
    const situation =
      lastSeen === undefined
        ? `${worker} ни разу не выходил на связь, ${waiting.length} задач ждут уже ${minutes} минут`
        : `${worker} не выходит на связь уже ${minutes} минут, ${waiting.length} задач в очереди или в работе`
    const check = lastSeen === undefined ? "включён ли он и есть ли сеть" : "не выключен ли он, не уснул ли, не пропала ли сеть"
    notify(draft, key, "Исполнитель не на связи", `${situation} (посмотрите, ${check}).`)
  }
}

function heldRun(draft: Draft, id: number, token: string, states: string[]): RunRow {
  const run = getRow<RunRow>(draft.view, "runs", id)
  const issued = run !== undefined && states.includes(run.state) && run.issued !== null
  if (!issued || tokenFor(draft.env.tokenSecret ?? "", id, run!.issued!) !== token) {
    throw new DecideAuthError("эта задача не принадлежит этому токену")
  }
  return run!
}

function claimNext(draft: Draft, worker: string, claim: string) {
  const agents = agentsOf(draft, worker)
  const runs = rowsOf(draft.view, "runs")
    .map(({ data }) => data as RunRow)
    .filter((run) => run.state === "queued" || run.state === "claimed")
  const claimed = runs.filter((run) => run.state === "claimed")
  const groupLimit = (group: string) =>
    draft.rules.rules.find((rule) => rule.group === group)?.parallel ?? 1
  const claimable = (run: RunRow) =>
    run.state === "queued" &&
    agents.includes(ruleNamed(draft, run.rule)?.to ?? "") &&
    Date.parse(run.not_before) <= draft.now &&
    !claimed.some((other) => other.grp === run.grp && other.lane === run.lane) &&
    claimed.filter((other) => other.grp === run.grp).length < groupLimit(run.grp)

  // The same claim again means the answer got lost: it gets back the run it already has.
  const held = claimed.find((run) => run.claim === claim && workerOfRun(draft.rules, run.agent) === worker)
  const run = held ?? runs.find(claimable)
  if (run === undefined) return null
  if (held === undefined) {
    assignQueued(draft, run)
    settleSession(draft, getRow<RunRow>(draft.view, "runs", run.id)!)
  }
  const since = held !== undefined ? { claimed_at: run.claimed_at, link: run.link } : { claimed_at: draft.at, link: null }
  const claiming = { state: "claimed", claim, issued: draft.seq, seen_at: draft.at, rules_version: draft.env.rulesVersion ?? 0, ...since }
  put(draft, "runs", run.id, { ...claiming, ...nulls("last_issued", "last_result", "last_answer") })
  const claimedRun = getRow<RunRow>(draft.view, "runs", run.id)!
  const rule = ruleNamed(draft, claimedRun.rule)
  const job: Job = {
    run: claimedRun.id,
    rule: claimedRun.rule,
    agent: claimedRun.agent,
    cwd: rule?.cwd ?? "",
    group: claimedRun.grp,
    lane: claimedRun.lane,
    session: claimedRun.session,
    resume: claimedRun.resume,
    token: tokenFor(draft.env.tokenSecret ?? "", claimedRun.id, claimedRun.issued!),
    events: eventsOf(draft.view, claimedRun.id),
  }
  return job
}

/** Ends a run nothing will pick up again, and says so. */
function stopRun(draft: Draft, run: RunRow, why: string, summary: string, words: string) {
  put(draft, "runs", run.id, { state: "cancelled", finished_at: draft.at, summary })
  closeStopped(draft, run.id, summary)
  notify(draft, `run:${run.id}:${why}`, run.rule, words, threadOf(run))
}

const ruleGone = (run: RunRow): [string, string] => [
  `Правило «${run.rule}» исчезло, больше не раздаётся`,
  `Правило «${run.rule}» исчезло (удалено или переименовано), этот раунд больше не раздаётся. Чтобы сделать — вызовите событие заново.`,
]

/** A run that didn't get through waits to try again, and takes along whatever came in for the same thing meanwhile. */
export function retryLater(draft: Draft, run: RunRow, result: Receipt): Rejected[] {
  const { id } = run
  const { limits } = draft
  const attempts = run.attempts + 1
  const pauseMs = Math.min(
    limits.retryBaseMinutes * MINUTE * 2 ** (attempts - 1),
    limits.retryMaxMinutes * MINUTE,
  )
  const notBefore = draft.now + pauseMs
  const error = (result.error ?? "").trim().replace(/[.。]+$/, "") || "причина не названа"
  const unclaimed = nulls("claim", "claimed_at", "seen_at", "cancel_at")
  const rejected: Rejected[] = []
  for (const what of ["ask", "resolve", "later", "events"] as const) {
    for (const _ of result[what] ?? []) rejected.push({ what, reason: "неудавшийся раунд может только уведомлять" })
  }
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice)
  const failure = { attempts, error, ...unclaimed }
  if (ruleNamed(draft, run.rule) === undefined) {
    put(draft, "runs", id, failure)
    stopRun(draft, run, "rule-gone", ...ruleGone(run))
    return rejected
  }
  if (attempts >= limits.maxAttempts) {
    // Runs queued for this thread stay apart: they came in since, and get their own count and their own go.
    const summary = `Не получилось ${limits.maxAttempts} раз подряд, автоматические повторы кончились`
    const words = `Автоматическая обработка не завершилась ${limits.maxAttempts} раз подряд (застряло на: ${error}), автоматические повторы кончились. После исправления вызовите событие заново — начнётся с начала.`
    put(draft, "runs", id, failure)
    stopRun(draft, run, "stopped", summary, words)
    return rejected
  }
  put(draft, "runs", id, { state: "queued", not_before: iso(new Date(notBefore)), ...failure })
  const waiting = rowsOf(draft.view, "runs")
    .map(({ data }) => data as RunRow)
    .filter((other) => other.rule === run.rule && other.lane === run.lane && other.state === "queued")
  for (const other of waiting.filter((other) => other.id !== id)) {
    for (const link of rowsOf(draft.view, "run_events").filter(({ data }) => data["run_id"] === other.id)) {
      put(draft, "run_events", `${id}:${link.data["event_id"]}`, { run_id: id, event_id: link.data["event_id"] })
      set(draft, "run_events", `${other.id}:${link.data["event_id"]}`, null)
    }
    set(draft, "runs", other.id, null)
    if (other.resume !== null) put(draft, "runs", id, { resume: other.resume })
  }
  if (!result.notice?.some((notice) => !notice.fyi) && attempts === 3) {
    const time = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(notBefore)
    const words = `Автоматическая обработка не завершилась 3 раза подряд (застряло на: ${error}), в ${time} попробует сама ещё раз.`
    notify(draft, `run:${id}:failing`, run.rule, words, threadOf(run))
  }
  assignQueued(draft, getRow<RunRow>(draft.view, "runs", id)!)
  return rejected
}

function scheduleReview(draft: Draft, run: RunRow, later: Later) {
  const { rule, lane } = run
  const existing = rowsOf(draft.view, "timers")
    .map(({ data }) => data as TimerRow)
    .find((timer) => timer.rule === rule && timer.lane === lane && timer.key === later.key && timer.event_id === null)
  if (later.cancel === true) {
    if (existing !== undefined) set(draft, "timers", existing.id, null)
    return
  }
  const session = getRow<RunRow>(draft.view, "runs", run.id)?.session ?? null
  const fields = { at: iso(new Date(Date.parse(later.at!))), about: later.about ?? "", session, hops: hopsOf(draft, run) }
  if (existing !== undefined) {
    put(draft, "timers", existing.id, fields)
    return
  }
  const source = sourceOf(draft.view, run.id) ?? SCHEDULE
  add<TimerRow>(draft, "timers", { ...fields, rule, lane, key: later.key, source, event_id: null, created_at: draft.at })
}

/**
 * A receipt takes effect here, all of it in the one fact. A receipt that
 * says the code check failed (`verifyFailed`) does not finish the run: it
 * counts a verification round and queues the run again, until the limit —
 * then the run stops and a human gets an ask card.
 */
export function applyReceipt(draft: Draft, run: RunRow, result: Receipt): Rejected[] {
  const { id } = run
  const rule = ruleNamed(draft, run.rule)
  const summary = result.summary ?? ""
  const rejected: Rejected[] = []
  if (result.verifyFailed === true) {
    const verifyIterations = run.verifyIterations + 1
    for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice)
    for (const later of result.later ?? []) scheduleReview(draft, run, later)
    if (verifyIterations >= draft.limits.maxVerifyIterations) {
      put(draft, "runs", id, {
        state: "cancelled",
        finished_at: draft.at,
        summary,
        verifyIterations,
        error: "проверка не прошла",
      })
      closeStopped(draft, id, summary)
      createCard(draft, {
        key: `run:${id}:verify`,
        kind: "ask",
        title: "Проверка не проходит",
        text: `Проверка кодом не прошла ${draft.limits.maxVerifyIterations} раз подряд (${summary || "без подробностей"}). Что делать дальше?`,
        options: ["Исправить и проверить снова", "Принять без проверки", "Отменить задачу"],
        recommend: "Исправить и проверить снова",
        ...threadOf(run),
        run: id,
      })
      return rejected
    }
    put(draft, "runs", id, {
      state: "queued",
      not_before: draft.at,
      verifyIterations,
      summary,
      error: "проверка не прошла",
    })
    return rejected
  }
  put(draft, "runs", id, { state: result.outcome, finished_at: draft.at, summary, error: null, cancel_at: null })
  closeOpen(draft, (key) => key === `run:${id}:failing`, "потом получилось")
  closeOpen(draft, (key) => key === `run:${id}:unknown`, "результат вернулся")
  const eventIds = eventsOf(draft.view, id).map((event) => event.id)
  for (const card of rowsOf(draft.view, "cards")
    .map(({ data }) => data as CardRow)
    .filter((card) => card.answer_event !== null && eventIds.includes(card.answer_event) && card.state === "decided")) {
    put(draft, "cards", card.id, { state: "done", result: summary, closed_at: draft.at, version: card.version + 1 })
  }
  for (const item of result.resolve ?? []) {
    const card = rowsOf(draft.view, "cards")
      .map(({ data }) => data as CardRow)
      .find((open) => open.id === item.card && open.state === "open")
    if (card !== undefined) closeCard(draft, card, item.reason.trim(), `раунд ${id}`)
    else rejected.push({ card: item.card, reason: "карточка не в области проверки этого раунда" })
  }
  for (const ask of result.ask ?? []) cardFromReceipt(draft, run, "ask", ask)
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice)
  if (rule?.tell === "always" && result.outcome === "done") {
    const once = { fyi: true, once: true, ...threadOf(run), source: sourceOf(draft.view, id), run: id }
    notify(draft, `run:${id}:done`, run.rule, summary, once)
  }
  for (const later of result.later ?? []) scheduleReview(draft, run, later)
  for (const event of result.events ?? []) {
    if (rule?.emits !== undefined && typeMatches(rule.emits.types, event.type)) {
      ingest(draft, rule.emits.source, { ...event, hops: hopsOf(draft, run) + 1 })
    } else {
      rejected.push({ what: "events", reason: `правило «${run.rule}» не разрешает отправлять ${event.type}` })
    }
  }
  return rejected
}

function finish(draft: Draft, id: number, token: string, given: unknown) {
  const hash = digest(JSON.stringify(given ?? null))
  const prior = getRow<RunRow>(draft.view, "runs", id)
  // The same execution handing in again means the answer got lost: it gets the same answer, and nothing happens twice.
  if (prior !== undefined && prior.last_issued !== null && tokenFor(draft.env.tokenSecret ?? "", id, prior.last_issued) === token) {
    if (prior.last_result !== hash) throw new DecideConflictError("этот раунд уже сдал другой результат")
    return { rejected: JSON.parse(prior.last_answer ?? "[]") as Rejected[], duplicate: true }
  }
  const run = heldRun(draft, id, token, ["claimed", "unknown"])
  const result = parseResult(given)
  const session = result.session ?? run.session
  const usage = result.usage === undefined ? run.usage : { ...(run.usage ?? {}), ...result.usage }
  put(draft, "runs", id, { last_issued: run.issued, last_result: hash, issued: null, session, usage })
  let rejected: Rejected[] = []
  // Told to stop, one that failed first has stopped all the same: trying again would start what the owner ended.
  if (result.outcome === "cancelled" || (result.outcome === "failed" && run.cancel_at !== null)) {
    put(draft, "runs", id, {
      state: "cancelled",
      finished_at: draft.at,
      summary: result.summary ?? "",
      cancel_at: null,
    })
    closeStopped(draft, id, "остановлено")
  } else if (result.outcome === "failed") {
    rejected = retryLater(draft, run, result)
  } else {
    rejected = applyReceipt(draft, run, result)
  }
  put(draft, "runs", id, { last_answer: JSON.stringify(rejected) })
  return { rejected }
}

function answer(draft: Draft, id: number, given: RowData) {
  const card = getRow<CardRow>(draft.view, "cards", id)
  if (card === undefined) throw new DecideNotFoundError("такой карточки нет")
  if (given["channel"] !== undefined) {
    const channel = String(given["channel"])
    const allowed = draft.rules.channels[channel]?.answerers
    if (allowed !== undefined && !allowed.includes(typeof given["by"] === "string" ? given["by"] : "")) {
      throw new DecideAuthError("этот человек не может отвечать на эту карточку")
    }
    const delivery = getRow<DeliveryRow>(draft.view, "deliveries", `${id}:${channel}`)
    if (delivery?.ref === undefined || delivery.ref !== given["ref"]) {
      throw new DecideAuthError("это не то сообщение, которое было отправлено")
    }
  }
  if (card.state !== "open") return { changed: false, state: card.state }
  if (given["by"] !== undefined && (typeof given["by"] !== "string" || [...given["by"]].length > ANSWER_BY)) {
    throw new DecideInputError(`отвечающий — до ${ANSWER_BY} знаков`)
  }
  if (given["ref"] !== undefined && (typeof given["ref"] !== "string" || [...given["ref"]].length > ANSWER_REF)) {
    throw new DecideInputError(`номер сообщения — до ${ANSWER_REF} знаков`)
  }
  const words = card.kind === "notice" ? "комментарий" : "ответ"
  if (given["text"] !== undefined && typeof given["text"] !== "string") {
    throw new DecideInputError(`${words} — текст`)
  }
  const text = typeof given["text"] === "string" ? given["text"].trim() || null : null
  if (text !== null && [...text].length > ANSWER_TEXT) throw new DecideInputError(`${words} — до ${ANSWER_TEXT} знаков`)
  if (card.kind === "notice") {
    closeCard(draft, card, "обработано", typeof given["by"] === "string" ? given["by"] : null, text)
    return { changed: true, state: "closed" }
  }
  const optionCount = card.options.length
  const inRange =
    typeof given["choice"] === "number" && Number.isInteger(given["choice"]) && given["choice"] >= 0 && given["choice"] < optionCount
  if (given["choice"] === undefined ? text === null : !inRange) throw new DecideInputError("такого варианта нет")
  const rule = card.rule !== null ? ruleNamed(draft, card.rule) : undefined
  const { lane: subject, title: summary, hops = 0 } = card
  const choice = typeof given["choice"] === "number" ? given["choice"] : null
  const chosen = choice !== null ? card.options[choice] : null
  // The answer event is what the next round's worker reads (its job carries
  // only event rows, not the card): it has to say which option was picked,
  // or "cancel" is invisible to it. Before this fix the event carried no
  // choice at all.
  const detail = [chosen, text].filter((part): part is string => part !== null && part !== "").join(" — ")
  const event = { id: `card:${id}`, type: "card.answered", subject, summary, detail, hops }
  const eventId = recordEvent(draft, card.source ?? SCHEDULE, event, rule !== undefined ? [rule.name] : [])
  const decision = { choice, answer: text, by: typeof given["by"] === "string" ? given["by"] : null, decided_at: draft.at }
  put(draft, "cards", id, { state: "decided", ...decision, answer_event: eventId, version: card.version + 1 })
  if (chosen === CANCEL_OPTION) {
    // "Отменить задачу" ends the task: no new run, or the loop "5 failures →
    // ask → cancel → new run → 5 failures" never ends. The run the card
    // belongs to is cancelled too when it is still going (the verify card's
    // run is already cancelled by then, so this is a no-op for it).
    const linked = card.run_id !== null ? getRow<RunRow>(draft.view, "runs", card.run_id) : undefined
    if (linked !== undefined && (linked.state === "queued" || linked.state === "claimed" || linked.state === "unknown")) {
      put(draft, "runs", linked.id, { state: "cancelled", finished_at: draft.at, summary: `отменено: ${card.title}` })
      closeStopped(draft, linked.id, "отменено")
    }
    return { changed: true, state: "decided", cancelled: true }
  }
  if (rule !== undefined) enqueue(draft, rule, eventId, card.lane, card.agent === rule.to ? card.session : null)
  return { changed: true, state: "decided" }
}

function nextCard(draft: Draft, channel: string) {
  const { now } = draft
  const candidates = rowsOf(draft.view, "cards")
    .map(({ data }) => data as CardRow)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
  for (const card of candidates) {
    const key = `${card.id}:${channel}`
    const delivery: DeliveryRow = getRow<DeliveryRow>(draft.view, "deliveries", key) ?? {
      card_id: card.id,
      channel,
      version: 0,
      ref: null,
      tries: 0,
      first_try_at: null,
      not_before: null,
      error: null,
      given_up: 0,
    }
    const recentNote = card.fyi === 1 && Date.parse(card.created_at) >= now - 24 * 60 * MINUTE
    const worthSending = card.state === "open" || delivery.ref !== null || recentNote
    const resting = delivery.not_before !== null && Date.parse(delivery.not_before) > now
    if (card.quiet === 1 || delivery.version >= card.version || delivery.given_up === 1 || resting || !worthSending) continue
    const firstTry = delivery.first_try_at
    if (delivery.tries >= RESEND_AT.length || (firstTry !== null && now - Date.parse(firstTry) > RESEND_WINDOW)) {
      put(draft, "deliveries", key, { given_up: 1 })
      continue
    }
    const attempt = { tries: delivery.tries + 1, first_try_at: firstTry ?? draft.at, not_before: iso(new Date(now + MINUTE)) }
    put(draft, "deliveries", key, { card_id: card.id, channel, ...attempt })
    return {
      id: card.id,
      key: card.key,
      kind: card.kind,
      title: card.title,
      text: card.text,
      options: card.options,
      recommend: card.recommend,
      about: card.about,
      channel,
      ref: delivery.ref,
      version: card.version,
    }
  }
  return null
}

function heartbeat(draft: Draft, worker: string, running: unknown) {
  closeOffline(draft, worker)
  const ids = Array.isArray(running) ? running.filter((id): id is number => typeof id === "number") : []
  const held = (run?: RunRow): run is RunRow => run?.state === "claimed" && workerOfRun(draft.rules, run.agent) === worker
  const inHand = ids.map((id) => getRow<RunRow>(draft.view, "runs", id)).filter(held)
  // All stamped together, so however many runs a worker has on, it's one fact each time.
  const seen = getRow<RowData>(draft.view, "seen", `worker:${worker}`)
  if ([seen, ...inHand].every((row) => justSeen(draft, row))) return
  put(draft, "seen", `worker:${worker}`, { kind: "worker", name: worker, seen_at: draft.at })
  for (const run of inHand) put(draft, "runs", run.id, { seen_at: draft.at })
}

/** What the clock has brought: schedules come round, reviews come due, and anything gone quiet. */
function tick(draft: Draft) {
  const { now } = draft
  const { rules, timezone } = draft.rules
  for (const rule of rules) {
    if (eventRule(rule)) continue
    const text = cronOf(rule)
    const cron = parseCron(text)
    if (cron === null) continue
    const schedule = getRow<ScheduleRow>(draft.view, "schedules", rule.name)
    const next = nextRun(cron, now, timezone)
    if (next === null) continue
    if (schedule === undefined || schedule.cron !== text) {
      put(draft, "schedules", rule.name, { rule: rule.name, cron: text, next_at: iso(new Date(next)) })
      continue
    }
    if (now < Date.parse(schedule.next_at)) continue
    const before = latestBefore(cron, Date.parse(schedule.next_at), now, timezone)
    const key = `${rule.name}@${iso(new Date(before ?? now))}`
    if (!rowsOf(draft.view, "events").some(({ data }) => data["source"] === SCHEDULE && data["key"] === key)) {
      enqueue(draft, rule, recordEvent(draft, SCHEDULE, { id: key, type: "schedule.tick" }, [rule.name]), "")
    }
    put(draft, "schedules", rule.name, { next_at: iso(new Date(next)) })
  }
  const dueTimers = rowsOf(draft.view, "timers")
    .map(({ data }) => data as TimerRow)
    .filter((timer) => timer.event_id === null && Date.parse(timer.at) <= now)
    .sort((a, b) => a.at.localeCompare(b.at))
  for (const timer of dueTimers) {
    const rule = ruleNamed(draft, timer.rule)
    const event = { id: `timer:${timer.id}`, type: "timer.due", subject: timer.lane, hops: timer.hops ?? 0 }
    const eventId = recordEvent(draft, timer.source, event, rule !== undefined ? [rule.name] : [])
    put(draft, "timers", timer.id, { event_id: eventId })
    if (rule !== undefined) enqueue(draft, rule, eventId, timer.lane, timer.session)
  }
  sweep(draft)
}

// --- Minimal five-field cron (minute hour day-of-month month day-of-week) ---
// Supports `*`, lists, ranges, steps (`*/15`, `9-17/2`), month and weekday
// names, and 7 as Sunday. Day-of-month and day-of-week follow the usual
// rule: when both are restricted, either one matching is enough.

interface CronSet {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domStar: boolean
  dowStar: boolean
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function parseCronField(text: string, min: number, max: number, names: Record<string, number>): Set<number> | null {
  const values = new Set<number>()
  for (const item of text.split(",")) {
    const [range, stepText] = item.split("/")
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return null
    const read = (value: string): number | null => {
      const lowered = value.toLowerCase()
      if (lowered in names) return names[lowered]!
      const parsed = Number(value)
      return Number.isInteger(parsed) ? parsed : null
    }
    if (range === "*") {
      for (let value = min; value <= max; value += step) values.add(value)
      continue
    }
    if (range!.includes("-")) {
      const [fromText, toText] = range!.split("-")
      const from = read(fromText!)
      const to = read(toText!)
      if (from === null || to === null || from > to) return null
      for (let value = from; value <= to; value += step) values.add(value)
      continue
    }
    const single = read(range!)
    if (single === null) return null
    for (let value = single; value <= max; value += step) values.add(value)
  }
  return values
}

export function parseCron(text: string): CronSet | null {
  const fields = text.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string]
  const parsed = {
    minute: parseCronField(minute, 0, 59, {}),
    hour: parseCronField(hour, 0, 23, {}),
    dom: parseCronField(dom, 1, 31, {}),
    month: parseCronField(month, 1, 12, MONTH_NAMES),
    dow: parseCronField(dow, 0, 7, DOW_NAMES),
  }
  if (Object.values(parsed).some((set) => set === null)) return null
  const dowSet = parsed.dow!
  if (dowSet.has(7)) {
    dowSet.delete(7)
    dowSet.add(0)
  }
  return { ...parsed, domStar: dom === "*", dowStar: dow === "*" } as CronSet
}

interface DayParts {
  minute: number
  hour: number
  dom: number
  month: number
  dow: number
}

const partsInZone = (date: Date, timeZone: string): DayParts => {
  if (timeZone === "UTC") {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dom: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dow: date.getUTCDay(),
    }
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "numeric",
    hour: "numeric",
    hourCycle: "h23",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  }).formatToParts(date)
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun"
  return {
    minute: read("minute"),
    hour: read("hour"),
    dom: read("day"),
    month: read("month"),
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday),
  }
}

const cronMatches = (cron: CronSet, parts: DayParts): boolean => {
  if (!cron.minute.has(parts.minute) || !cron.hour.has(parts.hour) || !cron.month.has(parts.month)) return false
  const domMatch = cron.dom.has(parts.dom)
  const dowMatch = cron.dow.has(parts.dow)
  if (cron.domStar && cron.dowStar) return true
  if (cron.domStar) return dowMatch
  if (cron.dowStar) return domMatch
  return domMatch || dowMatch
}

/** Next run strictly after `fromMs`, or null when none comes within a year. */
export function nextRun(cron: CronSet, fromMs: number, timeZone: string): number | null {
  const start = Math.floor(fromMs / MINUTE) * MINUTE + MINUTE
  for (let at = start; at < start + 366 * 24 * 60 * MINUTE; at += MINUTE) {
    if (cronMatches(cron, partsInZone(new Date(at), timeZone))) return at
  }
  return null
}

/** Latest run in (`fromMs`, `toMs`], or null when there is none. */
export function latestBefore(cron: CronSet, fromMs: number, toMs: number, timeZone: string): number | null {
  const start = Math.floor(toMs / MINUTE) * MINUTE
  for (let at = start; at > fromMs && at > start - 366 * 24 * 60 * MINUTE; at -= MINUTE) {
    if (cronMatches(cron, partsInZone(new Date(at), timeZone))) return at
  }
  return null
}

/** Every input there is, each with its arguments named. What one returns is what the caller is told. */
const HANDLERS: Record<string, (draft: Draft, ...args: Array<unknown>) => unknown> = {
  rules(draft, given) {
    if (!isRecord(given) || !Array.isArray(given["rules"])) {
      throw new DecideInputError("rules — объект Rules со списком rules")
    }
    const rules = given as unknown as Rules
    put(draft, "config", "rules", { value: rules, version: draft.seq })
    const named = new Set(rules.rules.map((rule) => rule.name))
    for (const run of rowsOf(draft.view, "runs")
      .map(({ data }) => data as RunRow)
      .filter((run) => run.state === "queued")) {
      if (named.has(run.rule)) assignQueued(draft, run)
      else stopRun(draft, run, "rule-gone", ...ruleGone(run))
    }
    closeOpen(draft, (key) => key.startsWith("rules:"), "правила обновлены")
  },

  rulesError: (draft, problem) =>
    notify(draft, `rules:${digest(String(problem))}`, "Правила записаны с ошибкой, действуют прежние", String(problem)),

  key: (draft, kind, name, hash) =>
    put(draft, "keys", `${kind}:${name}`, { kind, name, hash, created_at: draft.at }),

  removeKey: (draft, kind, name) => {
    if (getRow(draft.view, "keys", `${kind}:${name}`) === undefined) return false
    set(draft, "keys", `${kind}:${name}`, null)
    return true
  },

  ingest: (draft, source, given) => ingest(draft, needStr(source, "ingest.source"), given),

  createCard: (draft, spec) => createCard(draft, parseCardSpec(spec, "карточка")),

  enqueue: (draft, ruleName, eventId, lane, resume) => {
    const rule = ruleNamed(draft, needStr(ruleName, "enqueue.rule"))
    if (rule === undefined) throw new DecideNotFoundError(`правила нет: ${String(ruleName)}`)
    return enqueue(draft, rule, needNum(eventId, "enqueue.event"), typeof lane === "string" ? lane : "", typeof resume === "string" ? resume : null)
  },

  tell(draft, key, title, text) {
    const told = createCard(draft, { key: needStr(key, "tell.key"), title: needStr(title, "tell.title"), text: optText(text, "tell.text", 2000), kind: "notice", fyi: true, once: true })
    if (!told.duplicate) return told
    // Said again after every channel gave up on it: it gets another go.
    const givenUp = rowsOf(draft.view, "deliveries")
      .map(({ data }) => data as DeliveryRow)
      .filter((delivery) => delivery.card_id === told.card && delivery.given_up === 1)
    for (const { card_id, channel } of givenUp) {
      put(draft, "deliveries", `${card_id}:${channel}`, { given_up: 0, tries: 0, first_try_at: null, not_before: null })
    }
    if (givenUp.length === 0) return told
    put(draft, "cards", told.card, { text: optText(text, "tell.text", 2000), created_at: draft.at })
    return { ...told, duplicate: false }
  },

  heartbeat: (draft, worker, running) => heartbeat(draft, needStr(worker, "heartbeat.worker"), running),

  channelSeen(draft, name) {
    const seen = getRow<RowData>(draft.view, "seen", `channel:${String(name)}`)
    if (justSeen(draft, seen)) return
    put(draft, "seen", `channel:${String(name)}`, { kind: "channel", name: String(name), seen_at: draft.at })
  },

  claimNext: (draft, worker, claim) => claimNext(draft, needStr(worker, "claimNext.worker"), needStr(claim, "claimNext.claim")),

  started(draft, id, token, given) {
    const fields = isRecord(given) ? given : {}
    for (const [field, value] of Object.entries({ session: fields["session"], link: fields["link"] })) {
      if (value !== undefined && (typeof value !== "string" || value.length > 500)) {
        throw new DecideInputError(`${field} — строка до 500 знаков`)
      }
    }
    const run = heldRun(draft, needNum(id, "started.id"), needStr(token, "started.token"), ["claimed"])
    put(draft, "runs", run.id, {
      session: typeof fields["session"] === "string" ? fields["session"] : run.session,
      link: typeof fields["link"] === "string" ? fields["link"] : run.link,
      seen_at: draft.at,
    })
  },

  finish: (draft, id, token, given) => finish(draft, needNum(id, "finish.id"), needStr(token, "finish.token"), given),

  cancel(draft, id) {
    const run = getRow<RunRow>(draft.view, "runs", needNum(id, "cancel.id"))
    if (run === undefined) throw new DecideNotFoundError("такого раунда нет")
    if (run.state === "queued") {
      put(draft, "runs", run.id, { state: "cancelled", finished_at: draft.at })
      closeStopped(draft, run.id, "остановлено")
    } else if (run.state === "claimed") {
      put(draft, "runs", run.id, { cancel_at: draft.at })
    } else {
      throw new DecideInputError("этот раунд уже закончился")
    }
  },

  resolve(draft, id, reason, by) {
    const card = getRow<CardRow>(draft.view, "cards", needNum(id, "resolve.id"))
    if (card === undefined) throw new DecideNotFoundError("такой карточки нет")
    if (card.state !== "open") return false
    closeCard(draft, card, needStr(reason, "resolve.reason"), typeof by === "string" ? by : null)
    return true
  },

  answer: (draft, id, given) => {
    if (!isRecord(given)) throw new DecideInputError("answer — объект с выбором или текстом")
    return answer(draft, needNum(id, "answer.id"), given)
  },

  nextCard: (draft, channel) => nextCard(draft, needStr(channel, "nextCard.channel")),

  delivered(draft, channel, id, version, ref) {
    if (getRow(draft.view, "cards", needNum(id, "delivered.id")) === undefined) {
      throw new DecideNotFoundError("такой карточки нет")
    }
    if (ref !== null && ref !== undefined && (typeof ref !== "string" || [...ref].length > DELIVERY_REF)) {
      throw new DecideInputError(`номер сообщения — до ${DELIVERY_REF} знаков`)
    }
    const delivery: DeliveryRow = getRow<DeliveryRow>(draft.view, "deliveries", `${id}:${String(channel)}`) ?? {
      card_id: Number(id),
      channel: String(channel),
      version: 0,
      ref: null,
      tries: 0,
      first_try_at: null,
      not_before: null,
      error: null,
      given_up: 0,
    }
    const sent = { version: Math.max(delivery.version, needNum(version, "delivered.version")), ref: delivery.ref ?? (typeof ref === "string" ? ref : null) }
    put(draft, "deliveries", `${id}:${channel}`, { card_id: Number(id), channel: String(channel), ...sent, tries: 0, first_try_at: null, not_before: null, error: null })
  },

  failed(draft, channel, id, version, error) {
    const card = getRow<CardRow>(draft.view, "cards", needNum(id, "failed.id"))
    const delivery = getRow<DeliveryRow>(draft.view, "deliveries", `${id}:${String(channel)}`)
    if (card === undefined || delivery === undefined) throw new DecideNotFoundError("эта карточка не передавалась этому каналу")
    const firstTry = delivery.first_try_at !== null ? Date.parse(delivery.first_try_at) : draft.now
    const next =
      needNum(version, "failed.version") < card.version
        ? { not_before: null }
        : delivery.tries >= RESEND_AT.length
          ? { given_up: 1 }
          : { not_before: iso(new Date(firstTry + RESEND_AT[delivery.tries]! * MINUTE)) }
    put(draft, "deliveries", `${id}:${channel}`, { ...next, error: String(error).slice(0, 300) })
  },

  sweep,

  tick,
}
