import { expect, test } from "bun:test"
import { hoverBackground } from "../src/ui/hover"

test("uses the shared raised-high surface for hover", () => {
  const raisedHigh = "#262626"
  let increaseCalls = 0
  const value = hoverBackground({
    background: { base: "#101010", raised: { base: "#181818", high: raisedHigh } },
    increase: () => {
      increaseCalls++
      return "#222222"
    },
  })
  expect(value).toBe(raisedHigh)
  expect(increaseCalls).toBe(0)
})

test("falls back for a minimal theme without a raised-high surface", () => {
  const raisedBase = "#181818"
  const fallback = "#202020"
  const value = hoverBackground({
    background: { base: "#101010", raised: { base: raisedBase } },
    increase: (color, amount) => {
      expect(color).toBe(raisedBase)
      expect(amount).toBe(4)
      return fallback
    },
  })
  expect(value).toBe(fallback)
})
