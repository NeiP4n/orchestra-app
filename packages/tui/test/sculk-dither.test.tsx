import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  BAYER_4X4,
  BAYER_2X2,
  bayerDitherRow,
  ditherProgressBar,
  pixelStreamWave,
  quantizeDither,
  sculkSonicWave,
  SCULK_PIXEL_RAMP,
  SCULK_SONIC_RINGS,
} from "../src/ui/dither"
import { SCULK_PALETTE } from "../src/component/sculk-effects"

test("BAYER_4X4 and BAYER_2X2 are correctly normalized between 0 and 1", () => {
  expect(BAYER_4X4.length).toBe(16)
  for (let i = 0; i < 16; i++) {
    expect(BAYER_4X4[i]).toBeGreaterThanOrEqual(0)
    expect(BAYER_4X4[i]).toBeLessThan(1)
  }

  expect(BAYER_2X2.length).toBe(4)
  for (let i = 0; i < 4; i++) {
    expect(BAYER_2X2[i]).toBeGreaterThanOrEqual(0)
    expect(BAYER_2X2[i]).toBeLessThan(1)
  }
})

test("quantizeDither maps normalized values onto ramps", () => {
  expect(quantizeDither(0, SCULK_PIXEL_RAMP)).toBe(" ")
  expect(quantizeDither(1, SCULK_PIXEL_RAMP)).toBe("█")
  expect(quantizeDither(0.5, SCULK_PIXEL_RAMP)).toBeDefined()
})

test("bayerDitherRow generates dithered strings with strict width and caching", () => {
  const row0 = bayerDitherRow(0.5, 20, { row: 0, ramp: SCULK_PIXEL_RAMP })
  expect(row0.length).toBe(20)

  // Verify caching returns same string reference for identical inputs
  const cached = bayerDitherRow(0.5, 20, { row: 0, ramp: SCULK_PIXEL_RAMP })
  expect(cached).toBe(row0)

  // Empty width returns empty string
  expect(bayerDitherRow(0.5, 0)).toBe("")

  // 100% full gives solid blocks
  const full = bayerDitherRow(1.0, 10, { ramp: SCULK_PIXEL_RAMP })
  expect(full).toBe("██████████")

  // 0% empty gives empty spaces
  const empty = bayerDitherRow(0.0, 10, { ramp: SCULK_PIXEL_RAMP })
  expect(empty).toBe("          ")
})

test("pixelStreamWave generates waving pixel tendrils and spark particle", () => {
  const wave1 = pixelStreamWave(0, 12, { glowMode: true })
  expect(wave1.length).toBe(12)
  expect(wave1.endsWith("✧")).toBe(true)

  const wave2 = pixelStreamWave(1, 12, { glowMode: true })
  expect(wave2.length).toBe(12)
  expect(wave2.endsWith("✦")).toBe(true)

  expect(pixelStreamWave(0, 0)).toBe("")
})

test("sculkSonicWave produces concentric Minecraft Sculk resonance rings", () => {
  const sonic = sculkSonicWave(0)
  expect(sonic.length).toBeGreaterThan(0)
  expect(SCULK_SONIC_RINGS.some((ring) => sonic.includes(ring))).toBe(true)
})

test("ditherProgressBar calculates accurate ratio and dithered content", () => {
  const { filled, ratio, percent } = ditherProgressBar(50, 100, 16)
  expect(ratio).toBe(0.5)
  expect(percent).toBe(50)
  expect(filled.length).toBe(16)

  const zero = ditherProgressBar(0, 100, 10)
  expect(zero.ratio).toBe(0)
  expect(zero.percent).toBe(0)
  expect(zero.filled).toBe("          ")
})

test("SCULK_PALETTE exposes authentic Minecraft Sculk colors", () => {
  expect(SCULK_PALETTE.soulCyan.equals(RGBA.fromHex("#00e5ff"))).toBe(true)
  expect(SCULK_PALETTE.abyssalTeal.equals(RGBA.fromHex("#031d28"))).toBe(true)
  expect(SCULK_PALETTE.catalystBone.equals(RGBA.fromHex("#eedcaa"))).toBe(true)
  expect(SCULK_PALETTE.boneIvory.equals(RGBA.fromHex("#d6e3c9"))).toBe(true)
})
