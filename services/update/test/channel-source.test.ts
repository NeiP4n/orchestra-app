import { expect, test } from "bun:test"
import { channelSource } from "../src/channel-source"

for (const [input, output] of [
  ["0.0.0-dev-123", "dev"], ["v0.0.0-feature-a-123.4+commit", "feature-a"],
  ["0.0.0-dev-1+meta-2", "dev-1+meta"], ["0.0.0-dev-1+", "dev"],
  ["0.0.0-a-0+a-0+", "a-0+a"], ["0.0.0- -0", " "],
  ["0.0.0-a-1.2.3", undefined], ["0.0.0--1", undefined],
  ["1.0.0", undefined], ["0.0.0-dev-x", undefined],
  ["0.0.0-dev-1\n", undefined], ["0.0.0-dev-1+meta\u2028", undefined],
] as const) test(`channel source: ${JSON.stringify(input)}`, () => expect(channelSource(input)).toBe(output))

test("adversarial repeated suffixes stay bounded", () => {
  const start = performance.now()
  expect(channelSource("0.0.0-" + "a-0+".repeat(30_000) + "\n!")).toBeUndefined()
  expect(channelSource("0.0.0-" + "a-0.".repeat(30_000) + "!")).toBeUndefined()
  expect(performance.now() - start).toBeLessThan(500)
})
