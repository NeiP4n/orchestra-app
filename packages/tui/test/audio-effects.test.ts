import { describe, expect, test } from "bun:test"
import {
  coast,
  GLITCH_CHARS,
  GLITCH_DURATION,
  glitchText,
  HARMONIC_DURATION,
  HARMONIC_EMERALD,
  HARMONIC_GOLD,
  sampleHarmonicWave,
  smootherstep,
} from "../src/component/audio-effects"

describe("Audio Effects (Dissonance Glitch & Tutti Harmonic Flash)", () => {
  test("GLITCH_CHARS defines the acoustic discord symbol set", () => {
    expect(GLITCH_CHARS).toEqual(["░", "▒", "▓", "§", "⚡", "!"])
    expect(GLITCH_DURATION).toBe(300)
  })

  test("glitchText preserves text completely at progress 0 and 1 (restoration)", () => {
    const text = "Federated Symphony Orchestrator"
    expect(glitchText(text, 0)).toBe(text)
    expect(glitchText(text, 1.0)).toBe(text)
    expect(glitchText(text, -0.2)).toBe(text)
    expect(glitchText(text, 1.2)).toBe(text)
  })

  test("glitchText perturbs characters with glitch symbols during active glitch", () => {
    const text = "Orchestrator Harmony Baseline Check"
    const glitched = glitchText(text, 0.3, 123)

    expect(glitched).not.toBe(text)
    // Should contain at least one of the glitch characters
    const hasGlitchChar = GLITCH_CHARS.some((ch) => glitched.includes(ch))
    expect(hasGlitchChar).toBe(true)
  })

  test("coast curve has smooth acceleration, linear cruise, and soft deceleration", () => {
    expect(coast(0)).toBe(0)
    expect(coast(1)).toBe(1)
    expect(coast(0.5)).toBeCloseTo(0.5, 4)

    // Acceleration ramp (0 to 0.2): slower rise initially
    expect(coast(0.1)).toBeLessThan(0.1)

    // Deceleration ramp (0.8 to 1.0): slower approach to 1.0
    expect(coast(0.9)).toBeGreaterThan(0.9)
  })

  test("smootherstep smoothly clamps and transitions across 0..1", () => {
    expect(smootherstep(0)).toBe(0)
    expect(smootherstep(1)).toBe(1)
    expect(smootherstep(0.5)).toBe(0.5)
    expect(smootherstep(-0.5)).toBe(0)
    expect(smootherstep(1.5)).toBe(1)
  })

  test("sampleHarmonicWave produces dual-wave emerald/gold pulse", () => {
    expect(HARMONIC_DURATION).toBe(1000)
    expect(Math.round(HARMONIC_EMERALD.r * 255)).toBe(16)
    expect(Math.round(HARMONIC_EMERALD.g * 255)).toBe(185)
    expect(Math.round(HARMONIC_EMERALD.b * 255)).toBe(129)

    expect(Math.round(HARMONIC_GOLD.r * 255)).toBe(245)
    expect(Math.round(HARMONIC_GOLD.g * 255)).toBe(158)
    expect(Math.round(HARMONIC_GOLD.b * 255)).toBe(11)

    // Idle at boundaries
    const start = sampleHarmonicWave(0, 50, 0)
    expect(start.total).toBe(0)

    const finish = sampleHarmonicWave(0, 50, 1.0)
    expect(finish.total).toBe(0)

    // Mid-cycle wave samples
    const mid = sampleHarmonicWave(20, 50, 0.4)
    expect(mid.total).toBeGreaterThanOrEqual(0)
    expect(mid.total).toBeLessThanOrEqual(1)
    expect(mid.color.a).toBeCloseTo(mid.total, 2)
  })
})
