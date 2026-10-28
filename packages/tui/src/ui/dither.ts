// High-performance dithering and pixelation engine for terminal UIs.
// Zero-allocation lookup tables and Bayer matrices for terminal text and streaming streams.

/**
 * 4x4 Bayer Ordered Dither Matrix normalized to 0..1.
 * Standard formula: M(x, y) = Bayer16[y * 4 + x] / 16.0
 */
export const BAYER_4X4 = new Float32Array([
  0 / 16,  8 / 16,  2 / 16, 10 / 16,
 12 / 16,  4 / 16, 14 / 16,  6 / 16,
  3 / 16, 11 / 16,  1 / 16,  9 / 16,
 15 / 16,  7 / 16, 13 / 16,  5 / 16,
])

/**
 * 2x2 Bayer Matrix for compact 1-row terminal bars.
 */
export const BAYER_2X2 = new Float32Array([
  0 / 4, 2 / 4,
  3 / 4, 1 / 4,
])

/**
 * Standard Unicode block dithering ramps from light to full density.
 */
export const DITHER_BLOCKS = [" ", "░", "▒", "▓", "█"] as const

/**
 * Minecraft Sculk inspired pixel glyphs:
 * Abyssal space -> micro tendril -> sensor particle -> soul resonance -> solid catalyst
 */
export const SCULK_PIXEL_RAMP = [" ", "·", "▫", "░", "▒", "▓", "█"] as const

/**
 * Braille subcell dithering ramp for high-density micro-gauges.
 */
export const BRAILLE_DITHER_RAMP = [" ", "⠁", "⠃", "⠇", "⡇", "⣿"] as const

/**
 * Sculk Shrieker & Sensor sonic resonance ring phases.
 */
export const SCULK_SONIC_RINGS = ["·", "⌾", "◎", "◉", "●", "✺", "≋"] as const

/**
 * Pre-allocated character cache to avoid garbage collection churn in render loops.
 */
const CACHE_WIDTH_MAX = 120
const STRING_CACHE = new Map<string, string>()

/**
 * Fast quantized lookup for 0..1 value against a dither ramp.
 */
export function quantizeDither(value: number, ramp: readonly string[] = DITHER_BLOCKS): string {
  if (value <= 0) return ramp[0]
  if (value >= 1) return ramp[ramp.length - 1]
  const idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(value * ramp.length)))
  return ramp[idx]
}

/**
 * Generates an ordered-dither string using a 4x4 or 2x2 Bayer matrix.
 * Optimized with clamp and LUT indexing.
 */
export function bayerDitherRow(
  fraction: number,
  width: number,
  options?: {
    row?: number
    ramp?: readonly string[]
    phase?: number
    inverted?: boolean
  },
): string {
  if (width <= 0) return ""
  const ramp = options?.ramp ?? DITHER_BLOCKS
  const row = (options?.row ?? 0) & 3
  const phase = (options?.phase ?? 0) | 0
  const inverted = options?.inverted ?? false

  const clamped = Math.min(1, Math.max(0, fraction))
  const key = `${clamped.toFixed(2)}:${width}:${row}:${phase}:${ramp.length}:${inverted ? 1 : 0}`
  const cached = STRING_CACHE.get(key)
  if (cached) return cached

  const chars: string[] = new Array(width)
  for (let x = 0; x < width; x++) {
    const matrixCol = (x + phase) & 3
    const threshold = BAYER_4X4[row * 4 + matrixCol]
    // Value modulated by dither threshold
    let val = clamped
    if (val < 1 && val > 0) {
      val = val + (threshold - 0.5) * 0.35
      val = Math.min(1, Math.max(0, val))
    }
    const finalVal = inverted ? 1 - val : val
    chars[x] = quantizeDither(finalVal, ramp)
  }

  const result = chars.join("")
  if (STRING_CACHE.size > 200) STRING_CACHE.clear()
  if (width <= CACHE_WIDTH_MAX) STRING_CACHE.set(key, result)
  return result
}

/**
 * Pixelates an active streaming token boundary:
 * Creates a shimmering Sculk tendril / pixel wave representing continuous data flow.
 */
export function pixelStreamWave(
  frame: number,
  width: number = 12,
  options?: {
    tendrilDensity?: number
    glowMode?: boolean
  },
): string {
  if (width <= 0) return ""
  const density = options?.tendrilDensity ?? 0.6
  const glow = options?.glowMode ?? true

  const chars: string[] = new Array(width)
  for (let i = 0; i < width; i++) {
    // Wave oscillation modulated by position and frame
    const wave = Math.sin((frame * 0.28) + (i * 0.6)) * 0.5 + 0.5
    const ditherVal = wave * density
    if (glow && i === width - 1) {
      // Leading particle
      chars[i] = frame % 2 === 0 ? "✧" : "✦"
    } else {
      chars[i] = quantizeDither(ditherVal, SCULK_PIXEL_RAMP)
    }
  }
  return chars.join("")
}

/**
 * Sonic Resonance Wave: Emits concentric sonic rings like a Minecraft Sculk Shrieker
 * when a prompt, message, or tool event occurs.
 */
export function sculkSonicWave(frame: number, rings: number = 3): string {
  const f = Math.abs(frame)
  const ring1 = SCULK_SONIC_RINGS[f % SCULK_SONIC_RINGS.length]
  const ring2 = SCULK_SONIC_RINGS[(f + 2) % SCULK_SONIC_RINGS.length]
  const ring3 = SCULK_SONIC_RINGS[(f + 4) % SCULK_SONIC_RINGS.length]
  return `${ring3} ${ring2} ${ring1}`
}

/**
 * Dithered Progress / Budget Bar:
 * Smooth gradient with ordered dithering transition.
 */
export function ditherProgressBar(
  current: number,
  total: number,
  width: number = 20,
  row: number = 0,
): { filled: string; ratio: number; percent: number } {
  if (total <= 0 || width <= 0) {
    return { filled: "".padEnd(width, " "), ratio: 0, percent: 0 }
  }
  const ratio = Math.min(1, Math.max(0, current / total))
  const percent = Math.round(ratio * 100)
  const filled = bayerDitherRow(ratio, width, { row, ramp: SCULK_PIXEL_RAMP })
  return { filled, ratio, percent }
}
