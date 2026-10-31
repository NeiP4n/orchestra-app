import { expect, test } from "bun:test"
import { SessionCompaction } from "@orchestra/core/session/compaction"
import { SessionPlan } from "@orchestra/core/session/plan"

test("a chat's threshold is either a token count or a share of the window", () => {
  expect(SessionPlan.parseThreshold("60%")).toEqual({ type: "percent", percent: 60 })
  expect(SessionPlan.parseThreshold("62.5 %")).toEqual({ type: "percent", percent: 62.5 })
  expect(SessionPlan.parseThreshold("150k")).toEqual({ type: "tokens", tokens: 150_000 })
  expect(SessionPlan.parseThreshold(200_000)).toEqual({ type: "tokens", tokens: 200_000 })
  expect(SessionPlan.parseThreshold("0")).toEqual({ type: "tokens", tokens: 0 })
  expect(SessionPlan.parseThreshold("120%")).toBeUndefined()
  expect(SessionPlan.parseThreshold("plenty")).toBeUndefined()
})

test("a share of the window is resolved against the model the chat ends up on", () => {
  expect(SessionCompaction.resolveSessionThreshold("60%", { context: 200_000, output: 32_000 })).toBe(120_000)
  expect(SessionCompaction.resolveSessionThreshold("60%", { context: 0, input: 100_000, output: 8_000 })).toBe(60_000)
  // An unknown window leaves the model's own ceiling in charge instead of guessing a number.
  expect(SessionCompaction.resolveSessionThreshold("60%", { context: 0, output: 8_000 })).toBeUndefined()
  expect(SessionCompaction.resolveSessionThreshold(150_000, { context: 200_000, output: 32_000 })).toBe(150_000)
  expect(SessionCompaction.resolveSessionThreshold(0, { context: 200_000, output: 32_000 })).toBe(0)
  expect(SessionCompaction.resolveSessionThreshold(undefined, { context: 200_000, output: 32_000 })).toBeUndefined()
})
