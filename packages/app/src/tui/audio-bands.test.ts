import { expect, test } from "bun:test"
import { tuiAudioBands, TUI_IDLE_BANDS } from "./audio-bands"

test("the TUI idle header never changes with the clock", () => {
  expect(tuiAudioBands(false, 0)).toEqual([0.08, 0.12, 0.16, 0.2, 0.2, 0.16, 0.12, 0.08])
  expect(tuiAudioBands(false, 9999)).toEqual(TUI_IDLE_BANDS)
})

test("all eight bands follow the TUI harmonics and bounds", () => {
  expect(tuiAudioBands(true, 0)).toEqual([0.87, 1, 1, 0.793, 0.714, 0.933, 0.605, 0.232])
  for (const tick of [1, 20, 100, 9999]) {
    const bands = tuiAudioBands(true, tick)

    expect(bands).toHaveLength(8)
    expect(bands.every((level) => level >= 0.12 && level <= 1)).toBe(true)
    expect(bands).not.toEqual(TUI_IDLE_BANDS)
  }
})
