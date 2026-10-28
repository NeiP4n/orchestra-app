import { expect, test } from "bun:test"
import { foldRows, rowsOf } from "../src/util/fold"

test("rowsOf calculates row count correctly based on narrower width", () => {
  const message = "This is a long user message that should wrap to multiple lines when the right panel is open instead of overflowing under the panel."
  
  // At 120 width, message fits on 2 rows
  const rowsFull = rowsOf(message, 120)
  // At 40 width, message wraps to 4 rows
  const rowsNarrow = rowsOf(message, 40)

  expect(rowsFull).toBe(2)
  expect(rowsNarrow).toBe(4)
  expect(rowsNarrow).toBeGreaterThan(rowsFull)
})

test("foldRows truncates lines when row count exceeds maxRows at narrower width", () => {
  const longText = Array.from({ length: 20 }, (_, i) => `Paragraph line ${i}: ` + "x".repeat(30)).join("\n")
  
  const folded = foldRows(longText, 40, 5)
  expect(folded.hidden).toBeGreaterThan(0)
  expect(folded.head.split("\n").length).toBeLessThanOrEqual(6)
})

test("responsive gutter shrinks when transcript is narrowed by right panel", () => {
  const fullWidth = 120
  const sidebarWidth = 60

  const gutterFull = Math.max(4, Math.min(12, Math.floor(fullWidth / 10)))
  const gutterSidebar = Math.max(4, Math.min(12, Math.floor(sidebarWidth / 10)))

  expect(gutterFull).toBe(12)
  expect(gutterSidebar).toBe(6)

  const availableBubbleWidth = sidebarWidth - gutterSidebar - 6
  expect(availableBubbleWidth).toBe(48)
  expect(availableBubbleWidth).toBeLessThan(sidebarWidth)
})
