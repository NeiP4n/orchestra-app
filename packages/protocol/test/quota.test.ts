import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  calculateTokenQuota,
  evaluateTokenQuota,
  TokenQuotaSpec,
  validateTokenQuotaInput,
} from "../src/quota.js"

describe("Token Quota Specification & Validation", () => {
  test("decodes and encodes TokenQuotaSpec schema", () => {
    const raw: TokenQuotaSpec = {
      modelID: "claude-3-7-sonnet",
      contextWindowLimit: 200_000,
      spentTokens: 50_000,
      remainingTokens: 150_000,
      warningThreshold: 0.85,
      status: "ok",
      utilization: 0.25,
    }

    const decoded = Schema.decodeUnknownSync(TokenQuotaSpec)(raw)
    expect(decoded.modelID).toBe("claude-3-7-sonnet")
    expect(decoded.status).toBe("ok")
    expect(decoded.remainingTokens).toBe(150_000)

    const encoded = Schema.encodeSync(TokenQuotaSpec)(decoded)
    expect(encoded).toEqual(raw)
  })

  test("calculates 'ok' status when below warning threshold", () => {
    const quota = calculateTokenQuota({
      modelID: "gpt-4o",
      contextWindowLimit: 128_000,
      spentTokens: 64_000,
    })

    expect(quota.status).toBe("ok")
    expect(quota.remainingTokens).toBe(64_000)
    expect(quota.utilization).toBe(0.5)
    expect(quota.message).toBeUndefined()
  })

  test("calculates 'approaching_limit' when reaching warning threshold", () => {
    const quota = calculateTokenQuota({
      modelID: "deepseek-v3",
      contextWindowLimit: 100_000,
      spentTokens: 86_000,
      warningThreshold: 0.85,
    })

    expect(quota.status).toBe("approaching_limit")
    expect(quota.remainingTokens).toBe(14_000)
    expect(quota.utilization).toBe(0.86)
    expect(quota.message).toContain("Approaching token quota limit: 86.0% spent")
  })

  test("calculates 'exceeded' when tokens exceed context window", () => {
    const quota = calculateTokenQuota({
      modelID: "llama-3-70b",
      contextWindowLimit: 8_000,
      spentTokens: 8_500,
    })

    expect(quota.status).toBe("exceeded")
    expect(quota.remainingTokens).toBe(0)
    expect(quota.message).toContain("Token quota exceeded: spent 8500 of 8000 tokens")
  })

  test("supports custom warningThreshold between 0.8 and 0.9", () => {
    const quota80 = calculateTokenQuota({
      modelID: "gemini-1.5-pro",
      contextWindowLimit: 100_000,
      spentTokens: 81_000,
      warningThreshold: 0.8,
    })
    expect(quota80.status).toBe("approaching_limit")

    const quota90 = calculateTokenQuota({
      modelID: "gemini-1.5-pro",
      contextWindowLimit: 100_000,
      spentTokens: 81_000,
      warningThreshold: 0.9,
    })
    expect(quota90.status).toBe("ok")
  })

  test("validates quota input parameters", () => {
    expect(
      validateTokenQuotaInput({
        modelID: "claude-3-5",
        contextWindowLimit: 200_000,
        spentTokens: 10_000,
      }).valid,
    ).toBe(true)

    expect(
      validateTokenQuotaInput({
        modelID: "",
        contextWindowLimit: 200_000,
        spentTokens: 10_000,
      }).valid,
    ).toBe(false)

    expect(
      validateTokenQuotaInput({
        modelID: "claude-3-5",
        contextWindowLimit: -100,
        spentTokens: 10_000,
      }).valid,
    ).toBe(false)

    expect(
      validateTokenQuotaInput({
        modelID: "claude-3-5",
        contextWindowLimit: 200_000,
        spentTokens: -50,
      }).valid,
    ).toBe(false)

    expect(
      validateTokenQuotaInput({
        modelID: "claude-3-5",
        contextWindowLimit: 200_000,
        spentTokens: 10_000,
        warningThreshold: 1.5,
      }).valid,
    ).toBe(false)
  })

  test("evaluates quota with validation reporting", () => {
    const validEval = evaluateTokenQuota({
      modelID: "qwen-2.5-coder",
      contextWindowLimit: 32_000,
      spentTokens: 16_000,
    })
    expect(validEval.valid).toBe(true)
    expect(validEval.spec.status).toBe("ok")

    const invalidEval = evaluateTokenQuota({
      modelID: "",
      contextWindowLimit: 32_000,
      spentTokens: 16_000,
    })
    expect(invalidEval.valid).toBe(false)
    expect(invalidEval.error).toBeDefined()
    expect(invalidEval.spec.status).toBe("exceeded")
  })
})
