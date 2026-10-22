import { describe, expect, test } from "bun:test"
import {
  createRateLimitContinuations,
  WARP_CONTINUATION_ATTEMPT_WINDOW_MS,
  WARP_CONTINUATION_MAX_ATTEMPTS,
  WARP_CONTINUATION_WINDOW_MS,
} from "../../src/feature-plugins/system/warp-continuation"

describe("WARP rate-limit continuation queue", () => {
  test("reports a recorded session once and waits for the next failure after a resume", () => {
    const continuations = createRateLimitContinuations(() => 1_000)
    continuations.record("ses_a")

    expect(continuations.due()).toEqual(["ses_a"])
    expect(continuations.claim("ses_a")).toBe(true)
    expect(continuations.due()).toEqual([])
    expect(continuations.claim("ses_a")).toBe(false)
  })

  test("queues every affected chat instead of only the first one", () => {
    const continuations = createRateLimitContinuations(() => 0)
    continuations.record("ses_b")
    continuations.record("ses_a")

    expect(continuations.due()).toEqual(["ses_b", "ses_a"])
    expect(continuations.claim("ses_a")).toBe(true)
    expect(continuations.due()).toEqual(["ses_b"])
  })

  test("stops resuming once the attempt ceiling inside the window is spent", () => {
    let time = 0
    const continuations = createRateLimitContinuations(() => time)

    for (let index = 0; index < WARP_CONTINUATION_MAX_ATTEMPTS; index++) {
      continuations.record("ses_a")
      expect(continuations.claim("ses_a")).toBe(true)
      continuations.commit("ses_a")
      time += 60_000
    }

    continuations.record("ses_a")
    expect(continuations.due()).toEqual([])
    expect(continuations.claim("ses_a")).toBe(false)

    time += WARP_CONTINUATION_ATTEMPT_WINDOW_MS
    continuations.record("ses_a")
    expect(continuations.claim("ses_a")).toBe(true)
  })

  test("never exceeds the configured attempt ceiling", () => {
    let time = 0
    const continuations = createRateLimitContinuations(() => time)
    const claimed: boolean[] = []
    for (let index = 0; index < WARP_CONTINUATION_MAX_ATTEMPTS + 2; index++) {
      continuations.record("ses_a")
      const accepted = continuations.claim("ses_a")
      claimed.push(accepted)
      if (accepted) continuations.commit("ses_a")
      time += 1
    }

    expect(claimed.filter(Boolean)).toHaveLength(WARP_CONTINUATION_MAX_ATTEMPTS)
  })

  test("a released claim costs nothing and can be resumed by the next rotation", () => {
    let time = 0
    const continuations = createRateLimitContinuations(() => time)
    continuations.record("ses_a")
    expect(continuations.claim("ses_a")).toBe(true)
    continuations.release("ses_a")

    expect(continuations.due()).toEqual(["ses_a"])
    expect(continuations.claim("ses_a")).toBe(true)
    continuations.commit("ses_a")
    expect(continuations.due()).toEqual([])
    expect(continuations.claim("ses_a")).toBe(false)
  })

  test("does not spend an attempt for a claim that a newer failure replaced", () => {
    let time = 0
    const continuations = createRateLimitContinuations(() => time)
    continuations.record("ses_a")
    expect(continuations.claim("ses_a")).toBe(true)
    // A retry for the same chat lands before its prompt goes out and frees the reservation.
    continuations.record("ses_a")
    continuations.commit("ses_a")

    // Two real continuations are still available: the discarded claim cost nothing.
    expect(continuations.claim("ses_a")).toBe(true)
    continuations.commit("ses_a")
    // The next failure must reopen the queue before another prompt is allowed.
    continuations.record("ses_a")
    expect(continuations.claim("ses_a")).toBe(true)
    continuations.commit("ses_a")
    expect(continuations.claim("ses_a")).toBe(false)
  })

  test("drops a failure that is older than the continuation window", () => {
    let time = 0
    const continuations = createRateLimitContinuations(() => time)
    continuations.record("ses_a")

    time = WARP_CONTINUATION_WINDOW_MS + 1
    expect(continuations.due()).toEqual([])
    expect(continuations.claim("ses_a")).toBe(false)
  })

  test("forgets a session that already moved on", () => {
    const continuations = createRateLimitContinuations(() => 0)
    continuations.record("ses_a")
    continuations.forget("ses_a")

    expect(continuations.due()).toEqual([])
    expect(continuations.claim("ses_a")).toBe(false)
  })

  test("keeps unrelated sessions untouched when one is forgotten", () => {
    const continuations = createRateLimitContinuations(() => 0)
    continuations.record("ses_a")
    continuations.record("ses_b")
    continuations.forget("ses_a")

    expect(continuations.due()).toEqual(["ses_b"])
  })
})

describe("WARP continuation after a per-address cap", () => {
  test("holds a capped chat until the exit address has changed", () => {
    const continuations = createRateLimitContinuations(() => 0)
    continuations.record("ses_capped", { addressCap: true })
    continuations.record("ses_throttled")

    expect(continuations.due()).toEqual(["ses_throttled"])
    expect(continuations.due({ addressChanged: true })).toEqual(["ses_capped", "ses_throttled"])
  })

  test("a later ordinary rate limit releases the hold", () => {
    const continuations = createRateLimitContinuations(() => 0)
    continuations.record("ses_a", { addressCap: true })
    continuations.record("ses_a")

    expect(continuations.due()).toEqual(["ses_a"])
  })
})
