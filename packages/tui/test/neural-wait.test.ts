import { describe, expect, test } from "bun:test"
import {
  expireWaiting,
  functionalEffectsEnabled,
  waitGlyph,
  waitSignal,
  WAIT_FLIP_MS,
  WAIT_TIMEOUT_MS,
  type Waiting,
} from "../src/component/neural-wait"

describe("approval wait", () => {
  test("an ask opens a wait and the answer closes it", () => {
    const waiting: Waiting = new Map()
    waitSignal(waiting, "ask", "ses_a", 100)
    expect(waiting.get("ses_a")).toEqual({ since: 100, pending: 1 })
    waitSignal(waiting, "answer", "ses_a", 200)
    expect(waiting.size).toBe(0)
  })

  test("two open decisions in one session need two answers, and keep the first start time", () => {
    const waiting: Waiting = new Map()
    waitSignal(waiting, "ask", "ses_a", 100)
    waitSignal(waiting, "ask", "ses_a", 300)
    expect(waiting.get("ses_a")).toEqual({ since: 100, pending: 2 })
    waitSignal(waiting, "answer", "ses_a", 400)
    expect(waiting.get("ses_a")).toEqual({ since: 100, pending: 1 })
    waitSignal(waiting, "answer", "ses_a", 500)
    expect(waiting.has("ses_a")).toBe(false)
  })

  test("sessions wait independently and other signals change nothing", () => {
    const waiting: Waiting = new Map()
    waitSignal(waiting, "ask", "ses_a", 0)
    waitSignal(waiting, "ask", "ses_b", 0)
    waitSignal(waiting, "tool", "ses_a", 10)
    waitSignal(waiting, "answer", "ses_c", 10)
    waitSignal(waiting, "answer", "ses_a", 20)
    expect([...waiting.keys()]).toEqual(["ses_b"])
  })

  test("an unanswered wait ends after the safety timeout, not before", () => {
    const waiting: Waiting = new Map()
    waitSignal(waiting, "ask", "ses_a", 1000)
    expireWaiting(waiting, 1000 + WAIT_TIMEOUT_MS - 1)
    expect(waiting.has("ses_a")).toBe(true)
    expireWaiting(waiting, 1000 + WAIT_TIMEOUT_MS)
    expect(waiting.has("ses_a")).toBe(false)
  })

  test("the glyph flips between ◐ and ◑ so the meaning survives without color", () => {
    expect(waitGlyph(0)).toBe("◐")
    expect(waitGlyph(WAIT_FLIP_MS - 1)).toBe("◐")
    expect(waitGlyph(WAIT_FLIP_MS)).toBe("◑")
    expect(waitGlyph(WAIT_FLIP_MS * 2)).toBe("◐")
    expect(waitGlyph(-5)).toBe("◐")
  })

  test("the effect is off unless neural_functional_effects is true", () => {
    expect(functionalEffectsEnabled(undefined)).toBe(false)
    expect(functionalEffectsEnabled({})).toBe(false)
    expect(functionalEffectsEnabled({ neural_functional_effects: false })).toBe(false)
    expect(functionalEffectsEnabled({ neural_functional_effects: true })).toBe(true)
  })
})
