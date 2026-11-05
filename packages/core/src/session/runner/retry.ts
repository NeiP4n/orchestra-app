export * as SessionRunnerRetry from "./retry.js"

import { AIError, ProviderCooldown, isRetryable } from "@orchestra/ai"
import { Agent } from "@orchestra/schema/agent"
import { Model } from "@orchestra/schema/model"
import { SessionError } from "@orchestra/schema/session-error"
import { Clock, Duration, Effect, Pull, Schedule } from "effect"
import { Bus } from "../../bus.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { isFreeTierAddressCap } from "../to-session-error.js"
import { classifyError } from "./error-taxonomy.js"

export { isRetryable }

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

// Exponential from 2s capped at 10s per gap, for 2 retries: 2, 4, then 10s at most, about 16s of
// waiting when every attempt fails (with jitter). A provider failure must never hold a step for
// most of an hour: the old allowance was 10 retries, about 84s of waiting plus the attempts
// themselves, and deterministic failures (409, quota, auth) retried just as hard as transient
// ones. `min` takes the faster schedule, so the cap applies per gap; `max` with `recurs` bounds
// the count.
const schedule = Schedule.max([
  Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("10 seconds")]),
  Schedule.recurs(2),
]).pipe(
  Schedule.jittered,
  Schedule.setInputType<Input>(),
)

// A timed-out attempt already waited minutes before failing, so the general allowance would let a
// dead provider hold a step for most of an hour. Cap those attempts well below it.
const MAX_TIMEOUT_RETRIES = 2

// A rate-limit pause longer than this is not a pause but a stop: the step fails and escalates
// (taxonomy A1/A2) instead of holding a fiber for hours. The provider's own retry-after is
// honored up to this cap; beyond it the orchestrator, society or president decides.
const MAX_RATE_LIMIT_WAIT_MS = 10 * 60_000

const retryAfterMsOf = (cause: AIError): number | undefined => {
  if (cause.reason._tag === "RateLimit" || cause.reason._tag === "ProviderInternal") return cause.reason.retryAfterMs
  return undefined
}

const isTimeout = (error: AIError) => error.reason._tag === "Transport" && error.reason.code === "Timeout"

export const policy = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule)
    let attempt = 1
    let timeouts = 0
    return (input: Input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const next = yield* step(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
        if (!next) return { retry: false as const }
        const [, duration] = next
        attempt++
        if (isTimeout(input.cause)) timeouts++
        const entry = classifyError(input.cause)
        const retriesUsed = attempt - 1
        // The pause is the slowest of the three honest signals: the exponential schedule, the
        // provider's own retry-after hint, and the shared provider cooldown (a 429 another
        // session caught). No retry waits past the cap, and a type whose taxonomy cap is 0
        // (deterministic: 409, quota, auth, content policy) never retries at all.
        const hint = retryAfterMsOf(input.cause)
        // A spent free-tier address is a per-address daily cap, not a provider
        // throttle: it installs no shared cooldown, since another address
        // clears it and waiting would only stall the other sessions.
        if (input.cause.reason._tag === "RateLimit" && !isFreeTierAddressCap(input.cause))
          ProviderCooldown.noteRateLimit(String(input.model.providerID), hint)
        const cooldownDelay = ProviderCooldown.cooldownDelayMs(String(input.model.providerID), hint)
        const delay = Math.max(Math.ceil(Duration.toMillis(duration)), cooldownDelay)
        // A hint past the cap is not clamped into a shorter wait: retrying
        // before retry-after has passed just earns another 429. The step
        // fails and escalates instead of holding a fiber for hours. An
        // unusable hint (NaN, Infinity, negative) is not a long pause at
        // all — it is no hint, so the step falls back to the ordinary
        // schedule instead of failing on a comparison NaN can never pass.
        const hintWithinCap =
          hint === undefined || !Number.isFinite(hint) || hint < 0 || hint <= MAX_RATE_LIMIT_WAIT_MS
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt,
          // Another attempt from an address that spent its free-tier day is wasted, so the step stops
          // at once instead of retrying a spent address; the work is picked up again from the
          // durable session state on the next prompt or a restart, not by waiting out the cap here.
          decision:
            input.retry &&
            timeouts <= MAX_TIMEOUT_RETRIES &&
            !isFreeTierAddressCap(input.cause) &&
            retriesUsed <= entry.maxRetries &&
            hintWithinCap
              ? { retry: true, delay }
              : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0 ? Math.ceil(event.decision.delay) : delay
        return { retry: true as const, attempt, delay: normalized }
      })
  })

// Retry state is per Session, but a 429 is a provider-wide fact: one Session's rate limit installs
// a shared cooldown (see `ProviderCooldown` in `@orchestra/ai`) that every other Session waits
// out instead of spending its own retries against the same throttled provider. The pause for a
// retry is `max(exponential schedule, provider retry-after, shared cooldown)`, capped at
// 10 minutes; past the cap the step fails and escalates rather than holding a fiber for hours.
export const make = (bus: Bus.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID)
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        const scheduled = yield* Clock.currentTimeMillis
        const at = scheduled + input.decision.delay
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at,
          error: input.error,
        })
        const remaining = Math.max(0, at - (yield* Clock.currentTimeMillis))
        yield* Effect.sleep(Duration.millis(remaining))
      })
    return { decide, wait }
  })
