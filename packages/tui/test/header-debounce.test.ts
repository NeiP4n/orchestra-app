import { describe, expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import {
  areBandsEqual,
  calculateAudioBands,
  DEFAULT_BAND_EPSILON,
  HEADER_ANIMATION_INTERVAL_MS,
  HeaderUpdateGovernor,
  IDLE_BANDS,
} from "../src/routes/session/header"

describe("SessionHeader Debouncing & Render Throttling (OPT-018)", () => {
  describe("areBandsEqual", () => {
    test("returns true for identical arrays or identical references", () => {
      const bands = [0.1, 0.2, 0.3, 0.4]
      expect(areBandsEqual(bands, bands)).toBe(true)
      expect(areBandsEqual([0.1, 0.2, 0.3, 0.4], [0.1, 0.2, 0.3, 0.4])).toBe(true)
    })

    test("returns true when differences are within epsilon", () => {
      const a = [0.1, 0.2, 0.3]
      const b = [0.1 + DEFAULT_BAND_EPSILON / 2, 0.2, 0.3 - DEFAULT_BAND_EPSILON / 2]
      expect(areBandsEqual(a, b)).toBe(true)
    })

    test("returns false when differences exceed epsilon", () => {
      const a = [0.1, 0.2, 0.3]
      const b = [0.1 + DEFAULT_BAND_EPSILON * 2, 0.2, 0.3]
      expect(areBandsEqual(a, b)).toBe(false)
    })

    test("returns false when lengths differ or either array is undefined", () => {
      expect(areBandsEqual([0.1, 0.2], [0.1, 0.2, 0.3])).toBe(false)
      expect(areBandsEqual(undefined, [0.1])).toBe(false)
      expect(areBandsEqual([0.1], undefined)).toBe(false)
      expect(areBandsEqual(undefined, undefined)).toBe(true)
    })
  })

  describe("HeaderUpdateGovernor", () => {
    test("has default minimum interval aligned with 30 fps (~33ms)", () => {
      const governor = new HeaderUpdateGovernor()
      expect(governor.minIntervalMs).toBe(HEADER_ANIMATION_INTERVAL_MS)
      expect(governor.minIntervalMs).toBe(33)
    })

    test("throttles burst events within interval window", () => {
      const governor = new HeaderUpdateGovernor(33)
      let currentTime = 1000

      const initialBands = [0.2, 0.4, 0.6, 0.8]
      const firstAllowed = governor.shouldUpdate(true, initialBands, currentTime)
      expect(firstAllowed).toBe(true)

      // Burst of 50 rapid stream events arriving every 0.5ms (total 25ms elapsed < 33ms)
      let allowedCount = 0
      for (let i = 1; i <= 50; i++) {
        currentTime += 0.5
        const dynamicBands = [0.2 + i * 0.005, 0.4, 0.6, 0.8]
        if (governor.shouldUpdate(true, dynamicBands, currentTime)) {
          allowedCount++
        }
      }

      expect(allowedCount).toBe(0)
      expect(governor.stats.updates).toBe(1)
      expect(governor.stats.skipped).toBe(50)

      // Advance clock past 33ms window (currentTime is 1025 + 10 = 1035ms, elapsed 35ms > 33ms)
      currentTime += 10
      const nextBands = [0.5, 0.5, 0.5, 0.5]
      const nextAllowed = governor.shouldUpdate(true, nextBands, currentTime)
      expect(nextAllowed).toBe(true)
      expect(governor.stats.updates).toBe(2)
    })

    test("suppresses redundant repaints when idle or bands are unchanged", () => {
      const governor = new HeaderUpdateGovernor(33)
      let currentTime = 1000

      // First idle update records idle baseline
      const allowed1 = governor.shouldUpdate(false, IDLE_BANDS, currentTime)
      expect(allowed1).toBe(true)

      // Repeated idle ticks even 50ms later must be skipped as no values changed
      currentTime += 50
      const allowed2 = governor.shouldUpdate(false, IDLE_BANDS, currentTime)
      expect(allowed2).toBe(false)

      currentTime += 100
      const allowed3 = governor.shouldUpdate(false, IDLE_BANDS, currentTime)
      expect(allowed3).toBe(false)

      expect(governor.stats.updates).toBe(1)
      expect(governor.stats.skipped).toBe(2)
    })

    test("reset clears history and counter statistics", () => {
      const governor = new HeaderUpdateGovernor(33)
      governor.shouldUpdate(true, [0.5], 1000)
      governor.shouldUpdate(true, [0.6], 1010)

      expect(governor.stats.updates).toBe(1)
      expect(governor.stats.skipped).toBe(1)

      governor.reset()
      expect(governor.stats.updates).toBe(0)
      expect(governor.stats.skipped).toBe(0)

      // After reset, immediate update is allowed again
      expect(governor.shouldUpdate(true, [0.5], 1010)).toBe(true)
    })
  })

  describe("Reactive Solid equality deduplication", () => {
    test("areBandsEqual prevents reactive memo re-emissions when values stay within epsilon", () => {
      createRoot((dispose) => {
        try {
          const [signal, setSignal] = createSignal<number[]>([0.1, 0.2, 0.3], {
            equals: areBandsEqual,
          })

          let memoRuns = 0
          const downstream = createMemo(() => {
            memoRuns++
            return signal()
          })

          // Initial read triggers calculation
          expect(downstream()).toEqual([0.1, 0.2, 0.3])
          expect(memoRuns).toBe(1)

          // Value changed within epsilon (< 0.01): signal comparator drops the update
          setSignal([0.1 + DEFAULT_BAND_EPSILON / 2, 0.2, 0.3])
          expect(downstream()).toEqual([0.1, 0.2, 0.3])
          expect(memoRuns).toBe(1)

          // Value changed significantly: triggers downstream memo recalculation
          setSignal([0.5, 0.2, 0.3])
          expect(downstream()).toEqual([0.5, 0.2, 0.3])
          expect(memoRuns).toBe(2)
        } finally {
          dispose()
        }
      })
    })

    test("calculateAudioBands returns stable idle bands when inactive", () => {
      const idle1 = calculateAudioBands(false)
      const idle2 = calculateAudioBands(false)
      expect(areBandsEqual(idle1, idle2)).toBe(true)
      expect(idle1).toEqual([...IDLE_BANDS])
    })
  })
})
