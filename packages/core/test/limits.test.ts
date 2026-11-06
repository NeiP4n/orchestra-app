import { describe, expect, test } from "bun:test"
import { Limits } from "../src/limits"

// Limits are enforced by default (G2-3): no env means on. Only an explicit
// opt-out switches them off.
const def = {}
const on = { ORCHESTRA_ENFORCE_LIMITS: "1" }
const off = { ORCHESTRA_DISABLE_LIMITS: "1" }
const offLegacy = { ORCHESTRA_ENFORCE_LIMITS: "0" }

describe("Limits", () => {
  test("is enforced by default; only an explicit opt-out disables it", () => {
    expect(Limits.enforced(def)).toBe(true)
    expect(Limits.enforced(on)).toBe(true)
    expect(Limits.enforced({ ORCHESTRA_ENFORCE_LIMITS: "true" })).toBe(true)
    expect(Limits.enforced(off)).toBe(false)
    expect(Limits.enforced(offLegacy)).toBe(false)
    expect(Limits.enforced({ ORCHESTRA_ENFORCE_LIMITS: "false" })).toBe(false)
  })

  test("a misspelled or garbage switch never silently disables limits", () => {
    expect(Limits.enforced({ ORCHESTRA_ENFORCE_LIMITS: "yes" })).toBe(true)
    expect(Limits.enforced({ ORCHESTRA_DISABLE_LIMITS: "yes" })).toBe(true)
    expect(Limits.enforced({ ORCHESTRA_DISABLE_LIMITS: "0" })).toBe(true)
  })

  test("step ceilings apply by default", () => {
    expect(Limits.steps([5, 3], def)).toBe(3)
    expect(Limits.steps([undefined, 7], def)).toBe(7)
    expect(Limits.steps([undefined, undefined], def)).toBeUndefined()
  })

  test("the smaller step ceiling wins when enforced", () => {
    expect(Limits.steps([5, 3], on)).toBe(3)
    expect(Limits.steps([undefined, 7], on)).toBe(7)
    expect(Limits.steps([undefined, undefined], on)).toBeUndefined()
  })

  test("step ceilings are ignored only while disabled", () => {
    expect(Limits.steps([5, 3], off)).toBeUndefined()
    expect(Limits.steps([5, 3], offLegacy)).toBeUndefined()
  })

  test("timeouts are effectively unbounded only while disabled", () => {
    expect(Limits.timeout(undefined, 1000, off)).toBe(Limits.UNBOUNDED_MS)
    expect(Limits.UNBOUNDED_MS).toBeGreaterThan(24 * 24 * 60 * 60 * 1000)
  })

  test("explicit timeouts always apply and the fallback applies by default", () => {
    expect(Limits.timeout(500, 1000, off)).toBe(500)
    expect(Limits.timeout(undefined, 1000, def)).toBe(1000)
    expect(Limits.timeout(undefined, 1000, on)).toBe(1000)
    expect(Limits.timeout(500, 1000, on)).toBe(500)
  })

  test("drain budgets default to 4 hours and 10M estimated prompt tokens", () => {
    expect(Limits.drainWallClockMs(def)).toBe(4 * 60 * 60 * 1_000)
    expect(Limits.drainTokenBudget(def)).toBe(10_000_000)
    expect(Limits.drainWallClockMs(off)).toBeUndefined()
    expect(Limits.drainTokenBudget(off)).toBeUndefined()
  })

  test("drain budgets are tunable, and bad values fall back to the default", () => {
    expect(Limits.drainWallClockMs({ ORCHESTRA_DRAIN_WALL_CLOCK_MS: "60000" })).toBe(60_000)
    expect(Limits.drainTokenBudget({ ORCHESTRA_DRAIN_TOKEN_BUDGET: "1000" })).toBe(1000)
    expect(Limits.drainWallClockMs({ ORCHESTRA_DRAIN_WALL_CLOCK_MS: "0" })).toBe(Limits.DEFAULT_DRAIN_WALL_CLOCK_MS)
    expect(Limits.drainWallClockMs({ ORCHESTRA_DRAIN_WALL_CLOCK_MS: "-5" })).toBe(Limits.DEFAULT_DRAIN_WALL_CLOCK_MS)
    expect(Limits.drainWallClockMs({ ORCHESTRA_DRAIN_WALL_CLOCK_MS: "soon" })).toBe(
      Limits.DEFAULT_DRAIN_WALL_CLOCK_MS,
    )
    expect(Limits.drainTokenBudget({ ORCHESTRA_DRAIN_TOKEN_BUDGET: "lots" })).toBe(Limits.DEFAULT_DRAIN_TOKEN_BUDGET)
  })

  test("drain budget check fires on wall-clock first, then on tokens", () => {
    const fresh = { startedAtMs: 1000, tokensUsed: 0 }
    expect(Limits.drainBudgetExceeded(fresh, 1000, def)).toBeUndefined()
    expect(Limits.drainBudgetExceeded(fresh, 1000 + Limits.DEFAULT_DRAIN_WALL_CLOCK_MS, def)).toBe("wall-clock")
    expect(Limits.drainBudgetExceeded({ ...fresh, tokensUsed: 10_000_000 }, 1000, def)).toBe("tokens")
    expect(Limits.drainBudgetExceeded({ ...fresh, tokensUsed: 9_999_999 }, 1000, def)).toBeUndefined()
    expect(Limits.drainBudgetExceeded({ ...fresh, tokensUsed: 10_000_000 }, 1000, off)).toBeUndefined()
    expect(
      Limits.drainBudgetExceeded(
        { ...fresh, tokensUsed: 500 },
        1000,
        { ORCHESTRA_DRAIN_TOKEN_BUDGET: "500" },
      ),
    ).toBe("tokens")
  })
})
