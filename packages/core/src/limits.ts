import { SafetyConfig } from "./safety-config.js"
// Orchestra enforces its own limits by default: step ceilings, tool execution
// timeouts, and per-drain wall-clock/token budgets. Limits are a deployment
// safety net, not operator configuration — a runaway agent on paid models must
// stop by itself, so "no limits" is an explicit opt-out, never the default.
//
// Opt out only through the acknowledged operator safety control. Legacy OFF env values no longer suffice.
// ORCHESTRA_ENFORCE_LIMITS=1 still forces enforcement on. Any other value —
// including a typo — keeps enforcement on: a misspelled switch must never
// silently reopen the tap.
// Provider-side limits (rate limits, context windows) are not ours to lift and are handled by
// retry and compaction instead.
export const enforced = (env: Record<string, string | undefined> = process.env) => {
  // Explicit deployment ON still wins. OFF requires an operator acknowledgement in the local safety store.
  if (env.ORCHESTRA_ENFORCE_LIMITS === "1" || env.ORCHESTRA_ENFORCE_LIMITS === "true") return true
  return !SafetyConfig.disabled()
}
export const fullyDisabled = (env: Record<string, string | undefined> = process.env) => !enforced(env)

/** Smallest configured ceiling, or undefined when none applies. */
export const steps = (
  ceilings: ReadonlyArray<number | undefined>,
  env: Record<string, string | undefined> = process.env,
) => {
  if (!enforced(env)) return undefined
  const defined = ceilings.filter((ceiling) => ceiling !== undefined)
  return defined.length === 0 ? undefined : Math.min(...defined)
}

// Largest delay setTimeout accepts (about 24.8 days); clients that treat an omitted timeout
// as "use the library default" need a concrete number to mean "effectively none".
export const UNBOUNDED_MS = 2 ** 31 - 1

/** Acknowledged complete disable bypasses configured timeouts too. The runtime timer representation has a finite JS maximum. */
export const timeout = (
  configured: number | undefined,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
) => {
  if (!enforced(env)) return UNBOUNDED_MS
  if (configured !== undefined) return configured
  return fallback
}

// Drain budgets: the backstop under the step ceiling. A ceiling tells the
// model to finish; a budget stops the drain itself when the model does not —
// retries, continuations, or a turn that keeps admitting new input. Both are
// per drain (one resume), generous enough for a normal long session, and
// tunable without touching code. A non-positive or unparsable value falls back
// to the default: only the disable switch above turns budgets off, never a typo.

/** Default wall-clock budget for one session drain: 4 hours. */
export const DEFAULT_DRAIN_WALL_CLOCK_MS = 4 * 60 * 60 * 1_000

/** Default estimated prompt-token budget for one session drain: 10M tokens. */
export const DEFAULT_DRAIN_TOKEN_BUDGET = 10_000_000

const positiveInt = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Wall-clock budget for one drain in milliseconds, or undefined while limits are disabled. */
export const drainWallClockMs = (env: Record<string, string | undefined> = process.env) =>
  enforced(env) ? positiveInt(env.ORCHESTRA_DRAIN_WALL_CLOCK_MS, env === process.env ? SafetyConfig.read().drainMs ?? DEFAULT_DRAIN_WALL_CLOCK_MS : DEFAULT_DRAIN_WALL_CLOCK_MS) : undefined

/** Estimated prompt-token budget for one drain, or undefined while limits are disabled. */
export const drainTokenBudget = (env: Record<string, string | undefined> = process.env) =>
  enforced(env) ? positiveInt(env.ORCHESTRA_DRAIN_TOKEN_BUDGET, env === process.env ? SafetyConfig.read().drainTokens ?? DEFAULT_DRAIN_TOKEN_BUDGET : DEFAULT_DRAIN_TOKEN_BUDGET) : undefined

export interface DrainBudgetState {
  /** `Clock.currentTimeMillis` when the drain started. */
  readonly startedAtMs: number
  /** Estimated prompt tokens spent by this drain so far (measured + estimated). */
  readonly tokensUsed: number
}

export type DrainBudgetExceeded = "wall-clock" | "tokens"

/** Pure check: which drain budget (if any) this state has already spent. */
export const drainBudgetExceeded = (
  state: DrainBudgetState,
  nowMs: number,
  env: Record<string, string | undefined> = process.env,
): DrainBudgetExceeded | undefined => {
  const wallClock = drainWallClockMs(env)
  if (wallClock !== undefined && nowMs - state.startedAtMs >= wallClock) return "wall-clock"
  const tokens = drainTokenBudget(env)
  if (tokens !== undefined && state.tokensUsed >= tokens) return "tokens"
  return undefined
}

export * as Limits from "./limits.js"
