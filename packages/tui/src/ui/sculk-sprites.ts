import { RGBA } from "@opentui/core"

/**
 * Minecraft Deep Dark & Sculk Palette for Pixel Art Sprites.
 */
export const SCULK_SPRITE_PALETTE = {
  // Transparent
  ".": undefined,
  // Deep Abyssal Void & Dark Stone
  "V": RGBA.fromHex("#010c14"),
  "B": RGBA.fromHex("#031d28"),
  "D": RGBA.fromHex("#052431"),
  // Tendril & Vein Teals
  "T": RGBA.fromHex("#093d4f"),
  "M": RGBA.fromHex("#126978"),
  // Soul Cyan Bioluminescence
  "C": RGBA.fromHex("#00e5ff"),
  "G": RGBA.fromHex("#5df9de"),
  "S": RGBA.fromHex("#1fc2d9"),
  // Ancient Catalyst Bone Ivory
  "W": RGBA.fromHex("#f0ebd8"),
  "Y": RGBA.fromHex("#eedcaa"),
  "K": RGBA.fromHex("#d6e3c9"),
  // XP & Soul Sparks
  "X": RGBA.fromHex("#38ef7d"),
  "P": RGBA.fromHex("#a6ffea"),
} as const

export type SculkPixelKey = keyof typeof SCULK_SPRITE_PALETTE

export type SculkSpriteKind = "sensor" | "shrieker" | "catalyst" | "soul"
export type SculkSpriteState = "idle" | "active" | "vibrating"

export const SCULK_SPRITE_WIDTH = 12
export const SCULK_SPRITE_PIXEL_HEIGHT = 10
export const SCULK_SPRITE_CELL_HEIGHT = 5 // 5 text rows * 2 vertical pixels = 10 pixels

// ============================================================================
// 1. SCULK SENSOR (Сенсор скалка)
// Base block of catalyst stone with bone rim and 4 waving cyan tendrils on top.
// ============================================================================
const SENSOR_IDLE_0 = [
  "..C....C....", // Tendril tips
  "..C....C....",
  ".MC....MC...",
  ".TC....TC...",
  "YYYYYYYYYYYY", // Bone rim
  "YWWWWWWWWWWY",
  "BBBBBBBBBBBB", // Sculk block base
  "BBDDBBBBDDBB",
  "BBBBBBBBBBBB",
  "VVVVVVVVVVVV", // Bottom shadow
]

const SENSOR_VIBRATE_1 = [
  ".G......G...", // Tendrils waving outwards and glowing
  ".CC....CC...",
  ".GC....GC...",
  "TTC....TTC..",
  "YYYYYYYYYYYY",
  "YWWWWWWWWWWY",
  "BBCCBBBBCCBB", // Base resonance veins lighting up!
  "BBDDBBBBDDBB",
  "BBBBBBBBBBBB",
  "VVVVVVVVVVVV",
]

const SENSOR_VIBRATE_2 = [
  "P..G..G..P..", // Sonic ripple particles emitting!
  "..CC..CC....",
  "..GC..GC....",
  ".TTC..TTC...",
  "YYYYYYYYYYYY",
  "YWWGGGGGGWWY", // Rim glowing
  "BBDDBBBBDDBB",
  "BBBBBBBBBBBB",
  "BBBBBBBBBBBB",
  "VVVVVVVVVVVV",
]

const SENSOR_VIBRATE_3 = [
  "....G..G....", // Settle
  "..CC....CC..",
  ".MCC....MCC.",
  ".TC......TC.",
  "YYYYYYYYYYYY",
  "YWWWWWWWWWWY",
  "BBBBBBBBBBBB",
  "BBDDBBBBDDBB",
  "BBBBBBBBBBBB",
  "VVVVVVVVVVVV",
]

// ============================================================================
// 2. SCULK SHRIEKER (Крикун скалка)
// 4 bone horns/ridges, center soul shrieker mouth with spinning sonic boom.
// ============================================================================
const SHRIEKER_IDLE_0 = [
  "Y..........Y", // Horns
  "YY........YY",
  "YWY......YWY",
  "YWWY....YWWY",
  "YWWYYYYYYWWY", // Crest
  "YWWCCDDCCWWY", // Center mouth
  "BWCCDMDDCCWB",
  "BBWCCCCCCWBB",
  "BBBBWWWWBBBB", // Catalyst base
  "VVBBBBBBBBVV",
]

const SHRIEKER_ACTIVE_1 = [
  "Y..........Y",
  "YY........YY",
  "YWY......YWY",
  "YWWY....YWWY",
  "YWWYYYYYYWWY",
  "YWWGGCCGGWWY", // Core awakening
  "BWCGSSSSGCWB",
  "BBWCGGGCWBB",
  "BBBBWWWWBBBB",
  "VVBBBBBBBBVV",
]

const SHRIEKER_SHRIEK_2 = [
  "Y....PP....Y", // Sonic boom emitting upwards!
  "YY..PGGP..YY",
  "YWY.GGGG.YWY",
  "YWWYCCCCYWWY",
  "YWWYGGGGYWWY",
  "YWWGGGGGGWWY", // Full sonic resonance
  "BWGGSSSSGGWB",
  "BBWCGGGGCWBB",
  "BBBBWWWWBBBB",
  "VVBBBBBBBBVV",
]

const SHRIEKER_SHRIEK_3 = [
  "Y..P....P..Y", // Sonic ring expanding outward
  "YY........YY",
  "YWY..GG..YWY",
  "YWWY.CC.YWWY",
  "YWWYYYYYYWWY",
  "YWWCCGGCCWWY",
  "BWCCSSSSCCWB",
  "BBWCCCCCCWBB",
  "BBBBWWWWBBBB",
  "VVBBBBBBBBVV",
]

// ============================================================================
// 3. SCULK CATALYST (Катализатор скалка)
// Deep dark catalyst block with bone crests and bubbling XP orbs.
// ============================================================================
const CATALYST_IDLE_0 = [
  "............",
  "............",
  ".YY......YY.", // Bone crests
  "YYYY....YYYY",
  "YWWYYYYYYWWY",
  "BBDDCCCCDDBB", // Soul core inside
  "BBDCGGGCDBBB",
  "BBDDCCCCDDBB",
  "BBBBBBBBBBBB",
  "VVVVVVVVVVVV",
]

const CATALYST_BUBBLE_1 = [
  ".....XX.....", // XP orb rising
  "....XXXX....",
  ".YY..XX..YY.",
  "YYYY....YYYY",
  "YWWYYYYYYWWY",
  "BBDDGGCCDDBB", // Catalyst bloom
  "BBDCGGGCDBBB",
  "BBDDCCCCDDBB",
  "BBBBBBBBBBBB",
  "VVVVVVVVVVVV",
]

const CATALYST_BUBBLE_2 = [
  "....PXXP....", // Soul orb bursting with experience!
  "...PXXXXP...",
  ".YY..PP..YY.",
  "YYYY....YYYY",
  "YWWYYYYYYWWY",
  "BBCCGGGGCCBB",
  "BBCCGGGGCCBB",
  "BBDDCCCCDDBB",
  "BBBBBBBBBBBB",
  "VVVVVVVVVVVV",
]

const CATALYST_BUBBLE_3 = [
  "...P....P...", // Soul particles floating away
  "....P..P....",
  ".YY......YY.",
  "YYYY....YYYY",
  "YWWYYYYYYWWY",
  "BBDDCCCCDDBB",
  "BBDCGGGCDBBB",
  "BBDDCCCCDDBB",
  "BBBBBBBBBBBB",
  "VVVVVVVVVVVV",
]

// Frame registries
const SENSOR_FRAMES = [SENSOR_IDLE_0, SENSOR_VIBRATE_1, SENSOR_VIBRATE_2, SENSOR_VIBRATE_3]
const SHRIEKER_FRAMES = [SHRIEKER_IDLE_0, SHRIEKER_ACTIVE_1, SHRIEKER_SHRIEK_2, SHRIEKER_SHRIEK_3]
const CATALYST_FRAMES = [CATALYST_IDLE_0, CATALYST_BUBBLE_1, CATALYST_BUBBLE_2, CATALYST_BUBBLE_3]

export type SculkCell = {
  top?: RGBA
  bottom?: RGBA
}

/**
 * Returns a 2D matrix of terminal cells (5 rows by 12 columns).
 * Each cell has `top` and `bottom` pixels rendered via `▀`.
 */
export function sculkSpriteCells(
  kind: SculkSpriteKind,
  frameIndex: number,
  state: SculkSpriteState = "idle",
): SculkCell[][] {
  const frames =
    kind === "shrieker" ? SHRIEKER_FRAMES :
    kind === "catalyst" ? CATALYST_FRAMES :
    SENSOR_FRAMES

  const activeIndex = state === "idle" ? 0 : Math.abs(frameIndex) % frames.length
  const art = frames[activeIndex] ?? frames[0]!

  const result: SculkCell[][] = []
  for (let row = 0; row < SCULK_SPRITE_CELL_HEIGHT; row++) {
    const yTop = row * 2
    const yBottom = row * 2 + 1
    const cellRow: SculkCell[] = []

    for (let x = 0; x < SCULK_SPRITE_WIDTH; x++) {
      const charTop = art[yTop]?.[x] as SculkPixelKey | undefined
      const charBottom = art[yBottom]?.[x] as SculkPixelKey | undefined

      cellRow.push({
        top: charTop ? SCULK_SPRITE_PALETTE[charTop] : undefined,
        bottom: charBottom ? SCULK_SPRITE_PALETTE[charBottom] : undefined,
      })
    }
    result.push(cellRow)
  }

  return result
}
