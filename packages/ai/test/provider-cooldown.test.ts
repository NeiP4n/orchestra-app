import { describe, expect, test } from "bun:test"
import { ProviderCooldown } from "@orchestra/ai"

describe("ProviderCooldown", () => {
  test("a 429 installs a cooldown other sessions wait out", () => {
    ProviderCooldown.clearAllCooldowns()
    const now = Date.now()
    const until = ProviderCooldown.noteRateLimit("openai", 120_000, now)
    expect(until).toBe(now + 120_000)
    expect(ProviderCooldown.isCoolingDown("openai", now + 60_000)).toBe(true)
    expect(ProviderCooldown.cooldownRemainingMs("openai", now + 60_000)).toBe(60_000)
    expect(ProviderCooldown.isCoolingDown("openai", now + 120_001)).toBe(false)
    expect(ProviderCooldown.cooldownRemainingMs("openai", now + 120_001)).toBe(0)
  })

  test("cooldowns are per provider", () => {
    ProviderCooldown.clearAllCooldowns()
    ProviderCooldown.noteRateLimit("openai", 60_000)
    expect(ProviderCooldown.isCoolingDown("anthropic")).toBe(false)
    expect(ProviderCooldown.cooldownRemainingMs("anthropic")).toBe(0)
  })

  test("a missing hint waits a bounded default, never forever", () => {
    ProviderCooldown.clearAllCooldowns()
    const now = Date.now()
    ProviderCooldown.noteRateLimit("openai", undefined, now)
    expect(ProviderCooldown.cooldownRemainingMs("openai", now)).toBe(ProviderCooldown.DEFAULT_COOLDOWN_MS)
    expect(ProviderCooldown.cooldownRemainingMs("openai", now + ProviderCooldown.DEFAULT_COOLDOWN_MS + 1)).toBe(0)
  })

  test("a hint past the cap is clamped, not stored raw", () => {
    ProviderCooldown.clearAllCooldowns()
    const now = Date.now()
    ProviderCooldown.noteRateLimit("openai", 60 * 60_000, now)
    expect(ProviderCooldown.cooldownRemainingMs("openai", now)).toBe(ProviderCooldown.MAX_COOLDOWN_MS)
  })

  test("a longer cooldown wins, a shorter one does not shrink it", () => {
    ProviderCooldown.clearAllCooldowns()
    const now = Date.now()
    ProviderCooldown.noteRateLimit("openai", 120_000, now)
    ProviderCooldown.noteRateLimit("openai", 5_000, now)
    expect(ProviderCooldown.cooldownRemainingMs("openai", now)).toBe(120_000)
  })

  test("the retry delay is the longer of hint and shared cooldown", () => {
    ProviderCooldown.clearAllCooldowns()
    const now = Date.now()
    ProviderCooldown.noteRateLimit("openai", 90_000, now)
    expect(ProviderCooldown.cooldownDelayMs("openai", 10_000, now)).toBe(90_000)
    expect(ProviderCooldown.cooldownDelayMs("openai", 120_000, now)).toBe(120_000)
    expect(ProviderCooldown.cooldownDelayMs("openai", undefined, now)).toBe(90_000)
  })

  test("clearing a cooldown lets the provider be called again at once", () => {
    ProviderCooldown.clearAllCooldowns()
    ProviderCooldown.noteRateLimit("openai", 60_000)
    ProviderCooldown.clearCooldown("openai")
    expect(ProviderCooldown.isCoolingDown("openai")).toBe(false)
  })
})
