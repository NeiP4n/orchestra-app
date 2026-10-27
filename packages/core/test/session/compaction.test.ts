import { describe, expect, test } from "bun:test"
import {
  parseCompactionThreshold,
  formatCompactionThreshold,
} from "../../src/session/compaction"

describe("SessionCompaction Threshold Utilities (UI-001)", () => {
  describe("parseCompactionThreshold", () => {
    test("parses numeric values correctly", () => {
      expect(parseCompactionThreshold(400_000)).toBe(400_000)
      expect(parseCompactionThreshold(200_000)).toBe(200_000)
      expect(parseCompactionThreshold(0)).toBe(0)
      expect(parseCompactionThreshold(-100)).toBe(0)
      expect(parseCompactionThreshold(NaN)).toBe(0)
    })

    test("parses standard unit strings: k, K, m, M, b", () => {
      expect(parseCompactionThreshold("400k")).toBe(400_000)
      expect(parseCompactionThreshold("400K")).toBe(400_000)
      expect(parseCompactionThreshold("1.5m")).toBe(1_500_000)
      expect(parseCompactionThreshold("1.5M")).toBe(1_500_000)
      expect(parseCompactionThreshold("2m")).toBe(2_000_000)
      expect(parseCompactionThreshold("1b")).toBe(1_000_000_000)
    })

    test("parses raw numeric strings with formatting (commas, underscores, spaces)", () => {
      expect(parseCompactionThreshold("200000")).toBe(200_000)
      expect(parseCompactionThreshold("200,000")).toBe(200_000)
      expect(parseCompactionThreshold("200_000")).toBe(200_000)
      expect(parseCompactionThreshold(" 400 k ")).toBe(400_000)
      expect(parseCompactionThreshold(" 1.5 M ")).toBe(1_500_000)
    })

    test("handles zero, disabled and full window indicator strings", () => {
      expect(parseCompactionThreshold("0")).toBe(0)
      expect(parseCompactionThreshold("Без сжатия")).toBe(0)
      expect(parseCompactionThreshold("без сжатия")).toBe(0)
      expect(parseCompactionThreshold("без лимита")).toBe(0)
      expect(parseCompactionThreshold("Без лимита")).toBe(0)
      expect(parseCompactionThreshold("весь лимит")).toBe(0)
      expect(parseCompactionThreshold("Весь лимит")).toBe(0)
      expect(parseCompactionThreshold("весь")).toBe(0)
      expect(parseCompactionThreshold("Full window")).toBe(0)
      expect(parseCompactionThreshold("full window")).toBe(0)
      expect(parseCompactionThreshold("full")).toBe(0)
      expect(parseCompactionThreshold("all")).toBe(0)
      expect(parseCompactionThreshold("max")).toBe(0)
      expect(parseCompactionThreshold("none")).toBe(0)
      expect(parseCompactionThreshold("off")).toBe(0)
      expect(parseCompactionThreshold("disabled")).toBe(0)
      expect(parseCompactionThreshold("no limit")).toBe(0)
      expect(parseCompactionThreshold("unlimited")).toBe(0)
      expect(parseCompactionThreshold("")).toBe(0)
      expect(parseCompactionThreshold(undefined)).toBe(0)
      expect(parseCompactionThreshold(null)).toBe(0)
    })
  })

  describe("formatCompactionThreshold", () => {
    test("formats thousands to k suffix", () => {
      expect(formatCompactionThreshold(400_000)).toBe("400k")
      expect(formatCompactionThreshold(200_000)).toBe("200k")
      expect(formatCompactionThreshold(15_000)).toBe("15k")
      expect(formatCompactionThreshold(1_000)).toBe("1k")
    })

    test("formats millions to m suffix with decimal points", () => {
      expect(formatCompactionThreshold(1_500_000)).toBe("1.5m")
      expect(formatCompactionThreshold(2_000_000)).toBe("2m")
      expect(formatCompactionThreshold(1_250_000)).toBe("1.25m")
    })

    test("formats zero or non-positive as 'Без сжатия' by default or custom fallback", () => {
      expect(formatCompactionThreshold(0)).toBe("Без сжатия")
      expect(formatCompactionThreshold(-50)).toBe("Без сжатия")
      expect(formatCompactionThreshold(undefined)).toBe("Без сжатия")
      expect(formatCompactionThreshold(null)).toBe("Без сжатия")

      // Custom fallback string
      expect(formatCompactionThreshold(0, "Full window")).toBe("Full window")
      // With options object
      expect(formatCompactionThreshold(0, { fallback: "Full window" })).toBe("Full window")
      expect(formatCompactionThreshold(0, { locale: "en" })).toBe("Full window")
    })

    test("is symmetric and round-trippable with parseCompactionThreshold", () => {
      const values = [1_000, 15_000, 200_000, 400_000, 1_500_000, 2_000_000]
      for (const val of values) {
        const formatted = formatCompactionThreshold(val)
        const parsed = parseCompactionThreshold(formatted)
        expect(parsed).toBe(val)
      }
    })
  })
})
