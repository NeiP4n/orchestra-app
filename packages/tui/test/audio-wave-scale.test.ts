import { describe, expect, test } from "bun:test"
import {
  AudioWaveRenderable,
  formatAudioWaveString,
  scaleAudioBands,
  WAVE_BLOCKS,
} from "../src/component/audio-wave"

describe("AudioWave Adaptive Scaling & Multi-height Equalizer", () => {
  test("scaleAudioBands downsamples in compact mode for narrow viewports", () => {
    const eightBands = [0.1, 0.2, 0.5, 0.4, 0.8, 0.9, 0.3, 0.6]

    // Compact mode compresses pairs into max values (8 bands -> 4 bands)
    const compact = scaleAudioBands(eightBands, "compact")
    expect(compact.length).toBe(4)
    expect(compact[0]).toBe(0.2) // max(0.1, 0.2)
    expect(compact[1]).toBe(0.5) // max(0.5, 0.4)
    expect(compact[2]).toBe(0.9) // max(0.8, 0.9)
    expect(compact[3]).toBe(0.6) // max(0.3, 0.6)

    // Odd number of bands preserves the trailing band
    const oddBands = [0.1, 0.2, 0.7]
    const compactOdd = scaleAudioBands(oddBands, "compact")
    expect(compactOdd.length).toBe(2)
    expect(compactOdd[0]).toBe(0.2)
    expect(compactOdd[1]).toBe(0.7)
  })

  test("scaleAudioBands duplicates bands in wide mode", () => {
    const bands = [0.25, 0.75]
    const wide = scaleAudioBands(bands, "wide")

    expect(wide.length).toBe(4)
    expect(wide).toEqual([0.25, 0.25, 0.75, 0.75])
  })

  test("formatAudioWaveString renders 1-line string with scale options", () => {
    const bands = [0.0, 0.5, 1.0, 0.25]

    // Normal scale
    const normalStr = formatAudioWaveString(bands, { scale: "normal", height: 1 })
    expect(normalStr.length).toBe(4)
    expect(normalStr).toBe(" ▄█▂")

    // Compact scale: max(0, 0.5)=0.5, max(1.0, 0.25)=1.0 -> 2 characters
    const compactStr = formatAudioWaveString(bands, { scale: "compact", height: 1 })
    expect(compactStr.length).toBe(2)
    expect(compactStr).toBe("▄█")

    // Wide scale: 4 bands * 2 = 8 characters
    const wideStr = formatAudioWaveString(bands, { scale: "wide", height: 1 })
    expect(wideStr.length).toBe(8)
    expect(wideStr).toBe("  ▄▄██▂▂")
  })

  test("formatAudioWaveString supports multi-height vertical rendering (height > 1)", () => {
    const bands = [0.0, 0.5, 1.0]

    // 2-row height
    const multiRowStr = formatAudioWaveString(bands, { height: 2, scale: "normal" })
    const rows = multiRowStr.split("\n")
    expect(rows.length).toBe(2)

    // Top row (row 0)
    // - band 0 (0.0): active 0 -> space
    // - band 1 (0.5): active 0.5 * 16 = 8 -> rowBottom=8, rowTop=16 -> space (just reached bottom of top row)
    // - band 2 (1.0): active 1.0 * 16 = 16 -> full block on top row
    expect(rows[0]![0]).toBe(" ")
    expect(rows[0]![2]).toBe(WAVE_BLOCKS[8])

    // Bottom row (row 1)
    // - band 0 (0.0): space
    // - band 1 (0.5): full block on bottom row
    // - band 2 (1.0): full block on bottom row
    expect(rows[1]![0]).toBe(" ")
    expect(rows[1]![1]).toBe(WAVE_BLOCKS[8])
    expect(rows[1]![2]).toBe(WAVE_BLOCKS[8])
  })

  test("AudioWaveRenderable accepts custom scale and height", () => {
    const dummyCtx = {
      widthMethod: "wcwidth",
      addToHitGrid: () => {},
      requestRender: () => {},
    } as any

    const renderable = new AudioWaveRenderable(dummyCtx, {
      bands: [0.1, 0.3, 0.5, 0.7],
      height: 3,
      scale: "compact",
    })

    expect(renderable.height).toBe(3)
    expect(renderable.scale).toBe("compact")

    renderable.scale = "wide"
    expect(renderable.scale).toBe("wide")
  })
})
