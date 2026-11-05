import { describe, expect } from "bun:test"
import { AIError, ProviderCooldown, ProviderInternalError, QuotaExceededError, RateLimitError, TransportError } from "@orchestra/ai"
import { Agent } from "@orchestra/schema/agent"
import { Model } from "@orchestra/schema/model"
import { Provider } from "@orchestra/core/provider"
import type { Bus } from "@orchestra/core/bus"
import { SessionSchema } from "@orchestra/core/session/schema"
import { SessionRunnerRetry } from "@orchestra/core/session/runner/retry"
import { asRateLimit, toSessionError } from "@orchestra/core/session/to-session-error"
import { Duration, Effect } from "effect"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })
const rateLimit = new AIError({ reason: new RateLimitError({ message: "Too many requests" }) })

const input = (cause: AIError) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Decisions for `count` consecutive failures of the same cause within one step.
const decisions = (cause: AIError, count: number) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(input(cause))).retry)
    return results
  })

// The decision-only tests never publish events; wait() has separate bus coverage.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const retryBus = { publish: () => Effect.void } as unknown as Bus.Interface

describe("SessionRunnerRetry.policy", () => {
  it.effect("stops retrying transport timeouts after two attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 3)).toEqual([true, true, false])
    }),
  )

  it.effect("does not resend from an address that spent its free tier day", () =>
    Effect.gen(function* () {
      const cap = asRateLimit(
        new AIError({
          reason: new QuotaExceededError({
            message: "Rate limit exceeded. Please try again later.",
            body: JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Rate limit exceeded." } }),
          }),
        }),
      )
      expect(yield* decisions(cap, 1)).toEqual([false])
      expect(yield* decisions(rateLimit, 1)).toEqual([true])
    }),
  )

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 10)).toEqual([true, true, false, false, false, false, false, false, false, false])
    }),
  )

  it.effect("honors the provider retry-after hint and refuses a pause past the cap", () =>
    Effect.gen(function* () {
      // A 30s hint waits at least 30s; a 15-minute hint is not a pause but a stop.
      const hinted = new AIError({
        reason: new RateLimitError({ message: "Too many requests", retryAfterMs: 30_000 }),
      })
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_after"))
      const decision = yield* policy(input(hinted))
      expect(decision.retry).toBe(true)
      if (decision.retry) expect(decision.delay).toBeGreaterThanOrEqual(30_000)

      ProviderCooldown.clearAllCooldowns()
      const tooLong = new AIError({
        reason: new RateLimitError({ message: "Too many requests", retryAfterMs: Duration.toMillis("15 minutes") }),
      })
      const capped = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_after_cap"))
      expect((yield* capped(input(tooLong))).retry).toBe(false)

      // An unusable hint falls back to the ordinary schedule instead of failing the step.
      for (const retryAfterMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        ProviderCooldown.clearAllCooldowns()
        const cause = new AIError({
          reason: new RateLimitError({ message: "Too many requests", retryAfterMs }),
        })
        const fresh = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_after"))
        const next = yield* fresh(input(cause))
        expect(next.retry).toBe(true)
        if (next.retry) {
          expect(Number.isFinite(next.delay)).toBe(true)
          expect(next.delay).toBeGreaterThanOrEqual(0)
        }
      }
    }),
  )
})

describe("SessionRunnerRetry", () => {
  it.effect("treats a provider rate limit as an ordinary retryable failure", () =>
    Effect.gen(function* () {
      ProviderCooldown.clearAllCooldowns()
      const retry = yield* SessionRunnerRetry.make(retryBus, SessionSchema.ID.make("ses_rate_limit"))
      const decision = yield* retry.decide(input(rateLimit))
      expect(decision.retry).toBe(true)
      if (!decision.retry) throw new Error("A rate limit must stay retryable")
      // A 429 installs the shared provider cooldown: the pause is the cooldown
      // (60s default when the provider gives no hint), not the bare schedule.
      expect(decision.delay).toBeGreaterThanOrEqual(Duration.toMillis("10 seconds"))
      expect(decision.delay).toBeLessThanOrEqual(Duration.toMillis("10 minutes"))
    }),
  )

  it.effect("makes a second session wait out the shared cooldown instead of spending a retry", () =>
    Effect.gen(function* () {
      ProviderCooldown.clearAllCooldowns()
      const first = yield* SessionRunnerRetry.make(retryBus, SessionSchema.ID.make("ses_cooldown_first"))
      const second = yield* SessionRunnerRetry.make(retryBus, SessionSchema.ID.make("ses_cooldown_second"))
      const hinted = new AIError({
        reason: new RateLimitError({ message: "Too many requests", retryAfterMs: 120_000 }),
      })
      const firstDecision = yield* first.decide(input(hinted))
      expect(firstDecision.retry).toBe(true)
      // The second session never saw the 429 itself, but its pause still covers
      // the cooldown the first session installed.
      const secondDecision = yield* second.decide(input(rateLimit))
      expect(secondDecision.retry).toBe(true)
      if (secondDecision.retry && firstDecision.retry)
        expect(secondDecision.delay).toBeGreaterThanOrEqual(60_000)
    }),
  )
})
