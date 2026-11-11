import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { neuralHazeLevel, NEURAL_BAYER, NEURAL_DITHER_LEVELS } from "./neural-haze"

const tui = readFileSync(new URL("../../../tui/src/component/neural.tsx", import.meta.url), "utf8")
const web = readFileSync(new URL("./neural-haze.ts", import.meta.url), "utf8")

describe("TUI ordered-dither haze", () => {
  test("keeps the exact Bayer thresholds, tone ramps and noise implementation", () => {
    expect(NEURAL_BAYER).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => (n + 0.5) / 16))
    expect(NEURAL_DITHER_LEVELS).toEqual([0.1, 0.16, 0.24, 0.34])
    const start = "// Smooth value noise"
    const end = "// The cells between two nodes"
    const noise = tui.slice(tui.indexOf(start), tui.indexOf(end)).trim()

    expect(web).toContain(noise)
  })

  test("a quiet still frame has deterministic visible haze, and activity adds density", () => {
    const quiet: number[] = []
    const busy: number[] = []

    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 120; x++) {
        quiet.push(neuralHazeLevel(x, y, 0, 0))
        busy.push(neuralHazeLevel(x, y, 0, 1))
      }
    }

    expect(quiet.some((n) => n > 0)).toBe(true)
    expect(quiet).toEqual(quiet.map((_, i) => neuralHazeLevel(i % 120, Math.floor(i / 120), 0, 0)))
    expect(busy.filter((n) => n > 0).length).toBeGreaterThan(quiet.filter((n) => n > 0).length)
    expect(busy.every((n) => n >= 0 && n <= 4)).toBe(true)
  })

  test("node warmth blooms and the moving clock changes the pattern", () => {
    const still = Array.from({ length: 300 }, (_, i) => neuralHazeLevel(i % 30, Math.floor(i / 30), 0, 0))
    const moving = Array.from({ length: 300 }, (_, i) => neuralHazeLevel(i % 30, Math.floor(i / 30), 2, 0))
    const warm = Array.from({ length: 300 }, (_, i) => neuralHazeLevel(i % 30, Math.floor(i / 30), 0, 0, 0.5))

    expect(moving).not.toEqual(still)
    expect(warm.reduce((a, b) => a + b, 0)).toBeGreaterThan(still.reduce((a, b) => a + b, 0))
  })
})
