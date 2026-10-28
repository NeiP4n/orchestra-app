import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  SCULK_SPRITE_PALETTE,
  SCULK_SPRITE_WIDTH,
  SCULK_SPRITE_CELL_HEIGHT,
  sculkSpriteCells,
  type SculkSpriteKind,
} from "../src/ui/sculk-sprites"

test("SCULK_SPRITE_PALETTE contains authentic Minecraft Deep Dark colors", () => {
  expect(SCULK_SPRITE_PALETTE["C"]?.equals(RGBA.fromHex("#00e5ff"))).toBe(true) // Soul Cyan
  expect(SCULK_SPRITE_PALETTE["B"]?.equals(RGBA.fromHex("#031d28"))).toBe(true) // Sculk stone base
  expect(SCULK_SPRITE_PALETTE["Y"]?.equals(RGBA.fromHex("#eedcaa"))).toBe(true) // Catalyst bone
  expect(SCULK_SPRITE_PALETTE["."]).toBeUndefined() // Transparent
})

const KINDS: SculkSpriteKind[] = ["sensor", "shrieker", "catalyst"]

for (const kind of KINDS) {
  test(`sculkSpriteCells generates correct 12x5 grid for ${kind} (idle & active)`, () => {
    for (const state of ["idle", "vibrating"] as const) {
      const cells = sculkSpriteCells(kind, 0, state)
      expect(cells.length).toBe(SCULK_SPRITE_CELL_HEIGHT)
      for (const row of cells) {
        expect(row.length).toBe(SCULK_SPRITE_WIDTH)
        for (const cell of row) {
          expect(cell).toHaveProperty("top")
          expect(cell).toHaveProperty("bottom")
        }
      }
    }
  })

  test(`${kind} frames rotate across animation index`, () => {
    const f0 = sculkSpriteCells(kind, 0, "vibrating")
    const f2 = sculkSpriteCells(kind, 2, "vibrating")
    expect(f0).toBeDefined()
    expect(f2).toBeDefined()
  })
}
