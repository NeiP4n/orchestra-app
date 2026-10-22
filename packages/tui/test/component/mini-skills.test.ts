import { describe, expect, test } from "bun:test"
import { fittingSkills, moveSkill, placeSkill, type MiniSkill } from "../../src/component/prompt/mini-skills"

const skill = (id: string): MiniSkill => ({ id, label: id, icon: "*", instruction: `do ${id}` })
const ids = (items: MiniSkill[]) => items.map((item) => item.id)

describe("moveSkill", () => {
  const items = ["a", "b", "c", "d"].map(skill)

  test("moves one place either way and stops at the ends", () => {
    expect(ids(moveSkill(items, "b", 1))).toEqual(["a", "c", "b", "d"])
    expect(ids(moveSkill(items, "b", -1))).toEqual(["b", "a", "c", "d"])
    expect(moveSkill(items, "a", -1)).toBe(items)
    expect(moveSkill(items, "missing", 1)).toBe(items)
  })

  test("moves to the start or the end", () => {
    expect(ids(moveSkill(items, "c", -Infinity))).toEqual(["c", "a", "b", "d"])
    expect(ids(moveSkill(items, "b", Infinity))).toEqual(["a", "c", "d", "b"])
  })
})

describe("fittingSkills", () => {
  // every chip is 6 cells wide; the settings chip 10, the "+N" chip 5, one cell between chips
  const items = ["a", "b", "c", "d"].map(skill)
  const fit = (width: number) => ids(fittingSkills(items, width, () => 6, 10, 5))

  test("shows every skill when they all fit next to the settings chip, with no room kept for +N", () => {
    expect(fit(4 * 7 + 10)).toEqual(["a", "b", "c", "d"])
  })

  test("keeps room for the +N chip once some skills are left over", () => {
    expect(fit(3 * 7 + 6 + 10 - 1)).toEqual(["a", "b"])
    expect(fit(3 * 7 + 10 + 6)).toEqual(["a", "b", "c"])
  })

  test("shows none before the row has been measured", () => {
    expect(fit(0)).toEqual([])
  })
})

describe("placeSkill", () => {
  const items = ["a", "b", "c", "d"].map(skill)

  test("a chip dragged onto another takes its place, after it rightwards and before it leftwards", () => {
    expect(ids(placeSkill(items, "a", "c"))).toEqual(["b", "c", "a", "d"])
    expect(ids(placeSkill(items, "d", "b"))).toEqual(["a", "d", "b", "c"])
    expect(placeSkill(items, "a", "a")).toBe(items)
  })
})
