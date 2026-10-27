import { describe, expect, test } from "bun:test"
import {
  ATTACK_TIME,
  AudioWaveRenderable,
  createBandBallistics,
  DECAY_TIME,
  formatAudioWaveString,
  PEAK_DECAY_TIME,
  PEAK_HOLD_TIME,
  stepBandBallistics,
  WAVE_BLOCKS,
} from "../src/component/audio-wave"
import { calculateAudioBands, IDLE_BANDS } from "../src/routes/session/header"

describe("AudioWave pseudo-graphic equalizer and ballistics", () => {
  test("WAVE_BLOCKS contains all 9 discrete height levels", () => {
    expect(WAVE_BLOCKS.length).toBe(9)
    expect(WAVE_BLOCKS[0]).toBe(" ")
    expect(WAVE_BLOCKS[1]).toBe(" ")
    expect(WAVE_BLOCKS[2]).toBe("▂")
    expect(WAVE_BLOCKS[3]).toBe("▃")
    expect(WAVE_BLOCKS[4]).toBe("▄")
    expect(WAVE_BLOCKS[5]).toBe("▅")
    expect(WAVE_BLOCKS[6]).toBe("▆")
    expect(WAVE_BLOCKS[7]).toBe("▇")
    expect(WAVE_BLOCKS[8]).toBe("█")
  })

  test("defines correct audio ballistic timing constants", () => {
    expect(ATTACK_TIME).toBe(40)
    expect(DECAY_TIME).toBe(380)
    expect(PEAK_HOLD_TIME).toBe(260)
    expect(PEAK_DECAY_TIME).toBe(450)
  })

  test("initializes band ballistics with bounded values", () => {
    const zero = createBandBallistics(0)
    expect(zero.current).toBe(0)
    expect(zero.peak).toBe(0)
    expect(zero.peakHoldClock).toBe(0)

    const clamped = createBandBallistics(1.5)
    expect(clamped.current).toBe(1)
    expect(clamped.peak).toBe(1)
  })

  test("attack ballistics reaches full scale in 40ms", () => {
    let state = createBandBallistics(0)

    // After 20ms (half attack time)
    state = stepBandBallistics(state, 1.0, 20)
    expect(state.current).toBeCloseTo(0.5, 2)
    expect(state.peak).toBeCloseTo(0.5, 2)

    // After remaining 20ms (full attack)
    state = stepBandBallistics(state, 1.0, 20)
    expect(state.current).toBeCloseTo(1.0, 2)
    expect(state.peak).toBeCloseTo(1.0, 2)
    expect(state.peakHoldClock).toBe(PEAK_HOLD_TIME)
  })

  test("decay ballistics subsides from 1.0 to 0.0 in 380ms", () => {
    let state = { current: 1.0, peak: 1.0, peakHoldClock: 0 }

    // After 190ms (half decay)
    state = stepBandBallistics(state, 0.0, 190)
    expect(state.current).toBeCloseTo(0.5, 2)

    // After remaining 190ms (full decay)
    state = stepBandBallistics(state, 0.0, 190)
    expect(state.current).toBeCloseTo(0.0, 2)
  })

  test("peak hold locks peak position during hold time then decays", () => {
    let state = { current: 1.0, peak: 1.0, peakHoldClock: PEAK_HOLD_TIME }

    // Target drops to 0, advance 100ms: current decays, but peak must remain pinned at 1.0
    state = stepBandBallistics(state, 0.0, 100)
    expect(state.current).toBeLessThan(1.0)
    expect(state.peak).toBe(1.0)
    expect(state.peakHoldClock).toBe(PEAK_HOLD_TIME - 100)

    // Advance past remaining hold time (160ms) + 225ms of peak decay
    state = stepBandBallistics(state, 0.0, 160 + 225)
    expect(state.peakHoldClock).toBe(0)
    expect(state.peak).toBeCloseTo(0.5, 1)
  })

  test("formatAudioWaveString renders proper unicode pseudo-graphics", () => {
    const str = formatAudioWaveString([0.0, 0.25, 0.5, 0.75, 1.0])
    expect(str).toBe(" ▂▄▆█")
  })

  test("AudioWaveRenderable manages multiple frequency bands and advances ballistics", () => {
    // RenderContext mock
    const dummyCtx = {
      widthMethod: "wcwidth",
      addToHitGrid: () => {},
      requestRender: () => {},
    } as any

    const renderable = new AudioWaveRenderable(dummyCtx, {
      bands: [0, 0, 0],
      height: 3,
    })

    expect(renderable.bands.length).toBe(3)
    expect(renderable.ballistics.length).toBe(3)

    // Set new target bands
    renderable.bands = [1.0, 0.5, 0.8]
    expect(renderable.ballistics.length).toBe(3)

    // Step 40ms attack
    renderable.step(40)
    expect(renderable.ballistics[0]!.current).toBeCloseTo(1.0, 2)
    expect(renderable.ballistics[1]!.current).toBeCloseTo(0.5, 2)
    expect(renderable.ballistics[2]!.current).toBeCloseTo(0.8, 2)
  })

  test("calculateAudioBands returns 8 idle baseline bands when inactive", () => {
    const idle = calculateAudioBands(false)
    expect(idle.length).toBe(8)
    expect(idle).toEqual([...IDLE_BANDS])
    idle.forEach((val) => {
      expect(val).toBeGreaterThan(0)
      expect(val).toBeLessThanOrEqual(1)
    })
  })

  test("calculateAudioBands returns 8 modulated dynamic bands when active", () => {
    const active0 = calculateAudioBands(true, 0)
    expect(active0.length).toBe(8)
    active0.forEach((val) => {
      expect(val).toBeGreaterThanOrEqual(0.12)
      expect(val).toBeLessThanOrEqual(1.0)
    })

    const active10 = calculateAudioBands(true, 10)
    expect(active10.length).toBe(8)
    active10.forEach((val) => {
      expect(val).toBeGreaterThanOrEqual(0.12)
      expect(val).toBeLessThanOrEqual(1.0)
    })

    // Different tick values should produce dynamic changes
    expect(active0).not.toEqual(active10)
  })
})
