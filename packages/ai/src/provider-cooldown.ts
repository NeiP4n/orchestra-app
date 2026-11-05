/**
 * Process-shared provider cooldown (block Б5).
 *
 * One session catching a 429 must not let every other session burn its own
 * retries against the same throttled provider. The first 429 installs a
 * cooldown for the provider until the provider's own `retry-after` (or a
 * bounded default); the session retry policy then waits out the remaining
 * cooldown instead of retrying immediately, and other sessions see the same
 * deadline. The map is process-local on purpose: a restart clears it, and
 * the durable session state — not this map — owns what happens next.
 */

const cooldowns = new Map<string, number>()

/** Wait when the provider gave no usable hint. Long enough to matter, short enough to recover. */
export const DEFAULT_COOLDOWN_MS = 60_000
/** Never hold a session longer than this on a provider hint; beyond it the step fails and escalates. */
export const MAX_COOLDOWN_MS = 10 * 60_000

const clampCooldown = (retryAfterMs: number | undefined) => {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return DEFAULT_COOLDOWN_MS
  return Math.min(Math.ceil(retryAfterMs), MAX_COOLDOWN_MS)
}

/** Record that `providerID` answered 429 (or a quota signal) and return the new deadline. */
export const noteRateLimit = (providerID: string, retryAfterMs?: number | undefined, now: number = Date.now()) => {
  const until = now + clampCooldown(retryAfterMs)
  const previous = cooldowns.get(providerID)
  if (previous === undefined || until > previous) cooldowns.set(providerID, until)
  return until
}

/** Milliseconds of cooldown left for `providerID`, or 0 when it may be called again. */
export const cooldownRemainingMs = (providerID: string, now: number = Date.now()) =>
  Math.max(0, (cooldowns.get(providerID) ?? 0) - now)

/** Whether `providerID` is still inside a recorded cooldown. */
export const isCoolingDown = (providerID: string, now: number = Date.now()) =>
  cooldownRemainingMs(providerID, now) > 0

/** Delay a retry should wait: the provider's hint, or the shared cooldown, whichever is longer. */
export const cooldownDelayMs = (
  providerID: string,
  retryAfterMs?: number | undefined,
  now: number = Date.now(),
) => Math.max(retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0, cooldownRemainingMs(providerID, now))

export const clearCooldown = (providerID: string) => {
  cooldowns.delete(providerID)
}

export const clearAllCooldowns = () => {
  cooldowns.clear()
}

export * as ProviderCooldown from "./provider-cooldown.js"
