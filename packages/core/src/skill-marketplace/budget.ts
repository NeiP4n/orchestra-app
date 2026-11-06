export * as SkillMarketplaceBudget from "./budget.js"

import { Schema } from "effect"

/**
 * The token economy of the native marketplace. One request must cost
 * thousands of tokens, not tens of thousands: the live run burned 78k → 672k
 * input tokens in seven minutes because every step re-read the whole
 * context. Three mechanisms stop that here:
 *
 * 1. A hard per-request budget (default 10,000 tokens): the marketplace
 *    refuses to load more skill text once the budget is spent, and warns at
 *    80%. A budget is a stop, not a suggestion.
 * 2. Lazy loading: only the skill a task actually uses is read, and only its
 *    text — the compact index never counts against the budget.
 * 3. Compaction: a transcript is shrunk extractively (first message kept,
 *    last messages kept, the middle stubbed) instead of being re-read whole.
 *
 * Estimation is local and cheap: roughly four characters per token. It is an
 * estimate, and it errs on the side of counting more, so a stop never comes
 * as a surprise after the fact.
 */

/** Tokens one request may spend on marketplace-loaded skill text. */
export const DEFAULT_PER_REQUEST_TOKENS = 10_000
/** Warn when this fraction of the budget is spent. */
export const WARN_FRACTION = 0.8
/** Override with `ORCHESTRA_TOKEN_BUDGET_PER_REQUEST`. */
export const BUDGET_ENV = "ORCHESTRA_TOKEN_BUDGET_PER_REQUEST"

/** Characters per token for the local estimate. */
export const CHARS_PER_TOKEN = 4

/** Rough token count of a text, without a model call. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

/** The per-request budget, from the environment or the default. */
export const budgetFromEnv = (): number => {
  const raw = process.env[BUDGET_ENV]
  if (raw === undefined) return DEFAULT_PER_REQUEST_TOKENS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PER_REQUEST_TOKENS
}

export type Verdict = "ok" | "warn" | "stop"

export class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()("@orchestra/SkillMarketplace/BudgetExceeded", {
  message: Schema.String,
  spent: Schema.Number,
  budget: Schema.Number,
}) {}

/**
 * The running total for one request. Mutable on purpose: it is a meter, not
 * a value, and it is created fresh per request so one request can never
 * spend another's budget.
 */
export class Budget {
  readonly total: number
  private spentTokens = 0
  private warned = false

  constructor(total: number = budgetFromEnv()) {
    this.total = total
  }

  readonly spent = (): number => this.spentTokens
  readonly remaining = (): number => Math.max(0, this.total - this.spentTokens)
  /** True once a warning has been issued for this request. */
  readonly hasWarned = (): boolean => this.warned

  /** What spending `tokens` more would do, without spending it. */
  readonly check = (tokens: number): Verdict => {
    if (this.spentTokens + tokens > this.total) return "stop"
    if (this.spentTokens + tokens >= this.total * WARN_FRACTION) return "warn"
    return "ok"
  }

  /**
   * Spends `tokens` and answers what happened: `ok` while comfortable,
   * `warn` once at the 80% mark (the caller notifies the operator), `stop`
   * when the budget is exceeded — and the spend is then refused, so the
   * total never passes the cap.
   */
  readonly spend = (tokens: number): Verdict => {
    if (this.spentTokens + tokens > this.total) return "stop"
    this.spentTokens += tokens
    if (this.spentTokens >= this.total * WARN_FRACTION && !this.warned) {
      this.warned = true
      return "warn"
    }
    return "ok"
  }
}

/** One message of a transcript, for compaction. */
export interface TranscriptMessage {
  readonly role: string
  readonly text: string
}

export interface Compacted {
  readonly messages: readonly TranscriptMessage[]
  /** Estimated tokens the compaction saved. */
  readonly savedTokens: number
  /** How many messages were stubbed or dropped outright (not kept whole). */
  readonly dropped: number
}

/**
 * Shrinks a transcript to fit under `capTokens`, extractively and without a
 * model call: the first message (the task) and the newest messages are kept
 * whole, and the middle is replaced by one-line stubs (role + first words),
 * so the thread of the conversation survives without its bulk. When the
 * transcript already fits, it is returned unchanged. A message that fits
 * neither whole nor as a stub is dropped outright — the cap is a cap, and
 * the stubs themselves cost tokens, so they are counted as they are added.
 */
export const compactTranscript = (
  messages: readonly TranscriptMessage[],
  capTokens: number,
): Compacted => {
  const total = messages.reduce((sum, message) => sum + estimateTokens(message.text), 0)
  if (total <= capTokens) return { messages, savedTokens: 0, dropped: 0 }
  const first = messages[0]
  if (first === undefined) return { messages, savedTokens: 0, dropped: 0 }
  const kept: TranscriptMessage[] = [first]
  let keptTokens = estimateTokens(first.text)
  const stubs: TranscriptMessage[] = []
  let dropped = 0
  for (let index = messages.length - 1; index >= 1; index--) {
    const message = messages[index] as TranscriptMessage
    const cost = estimateTokens(message.text)
    if (keptTokens + cost <= capTokens) {
      kept.push(message)
      keptTokens += cost
      continue
    }
    const stubbed = stub(message)
    const stubCost = estimateTokens(stubbed.text)
    if (keptTokens + stubCost <= capTokens) {
      stubs.push(stubbed)
      keptTokens += stubCost
      continue
    }
    dropped++
  }
  const ordered = [kept[0] as TranscriptMessage, ...stubs.reverse(), ...kept.slice(1).reverse()]
  const saved = total - ordered.reduce((sum, message) => sum + estimateTokens(message.text), 0)
  return { messages: ordered, savedTokens: Math.max(0, saved), dropped: dropped + stubs.length }
}

const stub = (message: TranscriptMessage): TranscriptMessage => ({
  role: message.role,
  text: `[earlier ${message.role} message, compacted: ${message.text.slice(0, 60).replace(/\s+/g, " ").trim()}…]`,
})

/**
 * A model-based summarizer, for callers that want one: it replaces the
 * extractive fallback with a real summary from a cheap model. The
 * marketplace itself never calls a model — the caller owns the model, the
 * cost, and the choice — so this is a hook, not a dependency.
 */
export type Compactor = (
  messages: readonly TranscriptMessage[],
  capTokens: number,
) => Promise<Compacted>
