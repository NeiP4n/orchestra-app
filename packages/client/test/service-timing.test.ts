import { expect, test } from "bun:test"
import { defaultEnsureTiming, waitingTimeoutFor } from "../src/service-timing"

test("the waiting budget doubles with every replacement", () => {
  expect(waitingTimeoutFor(defaultEnsureTiming, 0)).toBe(30_000)
  expect(waitingTimeoutFor(defaultEnsureTiming, 1)).toBe(60_000)
  // Capped at half the overall deadline, so a replacement still has time to start.
  expect(waitingTimeoutFor(defaultEnsureTiming, 2)).toBe(60_000)
  expect(waitingTimeoutFor(defaultEnsureTiming, 5)).toBe(60_000)
})

test("a short overall deadline caps the waiting budget", () => {
  const timing = { ...defaultEnsureTiming, promiseTimeout: 3_000 }
  expect(waitingTimeoutFor(timing, 0)).toBe(1_500)
  expect(waitingTimeoutFor(timing, 3)).toBe(1_500)
})
