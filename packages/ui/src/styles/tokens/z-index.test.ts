import { describe, expect, test } from "bun:test"

// The single z-index scale (z-index.css): every overlay layer reads its
// z-index from these variables, so no overlay can silently end up under (or
// over) another one it was never meant to be near.

const css = await Bun.file(new URL("./z-index.css", import.meta.url)).text()

function zValues(): Map<string, number> {
  const map = new Map<string, number>()
  for (const match of css.matchAll(/--z-([\w-]+)\s*:\s*(\d+);/g)) {
    map.set(match[1], Number(match[2]))
  }
  return map
}

describe("z-index scale", () => {
  test("layers rise in the documented order", () => {
    const values = zValues()
    const order = ["content", "sticky", "scrollbar", "drawer", "dialog", "popover", "menu", "context-menu", "toast"]
    const numbers = order.map((name) => {
      const value = values.get(name)
      expect(value).toBeDefined()
      return value as number
    })
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBeGreaterThan(numbers[i - 1])
    }
  })

  test("dialogs stay below menus, menus below context menus, toasts on top", () => {
    const values = zValues()
    expect(values.get("dialog")).toBe(50)
    expect(values.get("popover")).toBe(60)
    expect(values.get("menu")).toBe(70)
    expect(values.get("context-menu")).toBe(100)
    expect(values.get("toast")).toBe(1000)
  })
})
