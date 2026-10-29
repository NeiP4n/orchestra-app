import { describe, expect, test } from "bun:test"
import {
  DONE_MS,
  FIRST_WORD_STALL_MS,
  SENT_MS,
  STALL_MS,
  createRate,
  flowLabel,
  flowMode,
  flowPattern,
  flowSpeed,
  type FlowSample,
} from "../src/effects/flow"

const sample = (patch: Partial<FlowSample>): FlowSample => ({
  busy: true,
  now: 100_000,
  startedAt: 100_000,
  sentAt: undefined,
  lastGrowthAt: undefined,
  finishedAt: undefined,
  ...patch,
})

describe("flow mode", () => {
  test("is quiet when nothing runs", () => {
    expect(flowMode(sample({ busy: false }))).toBe("idle")
  })

  test("flashes right after the message goes out, then waits for the first word", () => {
    expect(flowMode(sample({ sentAt: 100_000, now: 100_000 + SENT_MS - 1 }))).toBe("sent")
    expect(flowMode(sample({ sentAt: 100_000, now: 100_000 + SENT_MS }))).toBe("waiting")
  })

  test("streams while text keeps arriving and falls back to waiting when it pauses", () => {
    expect(flowMode(sample({ lastGrowthAt: 99_500 }))).toBe("streaming")
    expect(flowMode(sample({ lastGrowthAt: 96_000 }))).toBe("waiting")
  })

  test("calls a long silence stalled, with a longer allowance before the first word", () => {
    expect(flowMode(sample({ lastGrowthAt: 100_000 - STALL_MS }))).toBe("stalled")
    expect(flowMode(sample({ startedAt: 100_000 - FIRST_WORD_STALL_MS + 1 }))).toBe("waiting")
    expect(flowMode(sample({ startedAt: 100_000 - FIRST_WORD_STALL_MS }))).toBe("stalled")
  })

  test("shows done for a moment after the run ends, then dissolves", () => {
    expect(flowMode(sample({ busy: false, finishedAt: 100_000 - DONE_MS + 1 }))).toBe("done")
    expect(flowMode(sample({ busy: false, finishedAt: 100_000 - DONE_MS }))).toBe("idle")
  })
})

describe("flow text", () => {
  test("labels say what is happening in plain words", () => {
    expect(flowLabel("sent", sample({}), 0)).toBe("отправлено")
    expect(flowLabel("waiting", sample({ startedAt: 97_000 }), 0)).toBe("ждём ответа 3 с")
    expect(flowLabel("streaming", sample({ lastGrowthAt: 100_000 }), 41.6)).toBe("поток · 42 симв/с")
    expect(flowLabel("stalled", sample({ lastGrowthAt: 86_000 }), 0)).toBe("нет данных 14 с · Esc — прервать")
    expect(flowLabel("done", sample({ busy: false, startedAt: 90_000, finishedAt: 97_400 }), 0)).toBe("готово · 7 с")
    expect(flowLabel("idle", sample({}), 0)).toBe("")
  })

  test("the pattern follows the speed of the text", () => {
    expect(flowSpeed("streaming", 0)).toBeLessThan(flowSpeed("streaming", 400))
    expect(flowSpeed("streaming", 100_000)).toBe(36)
    expect(flowSpeed("idle", 500)).toBe(0)
    expect(flowSpeed("stalled", 500)).toBe(0)
  })

  test("a flowing line moves with the offset, a stalled one blinks and an idle one is empty", () => {
    expect(flowPattern("streaming", 8, 0)).toBe("░▒▓▒░▒▓▒")
    expect(flowPattern("streaming", 8, 1)).toBe("▒░▒▓▒░▒▓")
    expect(flowPattern("stalled", 4, 0, true)).toBe("╌╌╌╌")
    expect(flowPattern("stalled", 4, 0, false)).toBe("    ")
    expect(flowPattern("idle", 8, 3)).toBe("")
    expect(flowPattern("waiting", 12, 2)).toContain("▒")
    expect(flowPattern("streaming", 0, 0)).toBe("")
  })
})

describe("rate", () => {
  test("measures characters per second over a sliding window", () => {
    const rate = createRate(3_000)
    rate.push(0, 0)
    rate.push(1_000, 100)
    rate.push(2_000, 300)
    expect(rate.perSecond(2_000)).toBe(150)
    rate.push(6_000, 300)
    expect(rate.perSecond(6_000)).toBe(0)
  })

  test("reset forgets everything", () => {
    const rate = createRate()
    rate.push(0, 0)
    rate.push(1_000, 500)
    rate.reset()
    expect(rate.perSecond(1_000)).toBe(0)
  })
})

test("a view opened while the model is running counts from the newest message, not from now", async () => {
  const { inheritedStart } = await import("../src/effects/flow")
  expect(inheritedStart(false, 1_000, 5_000)).toBeUndefined()
  expect(inheritedStart(true, 1_000, 5_000)).toBe(1_000)
  expect(inheritedStart(true, undefined, 5_000)).toBe(5_000)
  // A message from the future (clock skew) must not give a negative wait.
  expect(inheritedStart(true, 9_000, 5_000)).toBe(5_000)
})
