import { describe, expect, spyOn, test } from "bun:test"
import type { OrchestraEvent } from "@orchestra/client"
import { NeuralActivity, neuralEnergyFloor } from "./neural-activity"

type ActivityEventData = { sessionID: string; id?: string; name?: string }

function event(type: OrchestraEvent["type"], data: ActivityEventData): OrchestraEvent {
  // SAFETY: these deliberately partial fixtures exercise only the activity reader's
  // type/sessionID/id/name fields, not transport validation or event replay.
  return { type, data } as OrchestraEvent
}

const SESSION = "ses_test"

describe("NeuralActivity", () => {
  test("level is 0 when quiet", () => {
    const activity = new NeuralActivity()
    expect(activity.level()).toBe(0)
    activity.dispose()
  })

  test("a tool call heats the network by its weight", () => {
    const activity = new NeuralActivity()
    activity.take(event("session.tool.called", { sessionID: SESSION, id: "call-1" }))
    // heat 3 -> 1 - exp(-3/10); precision 4, not 5: the heat cools a hair
    // between the take and the read.
    expect(activity.level()).toBeCloseTo(1 - Math.exp(-0.3), 4)
    activity.dispose()
  })

  test("level for given sessions counts only their heat", () => {
    const activity = new NeuralActivity()
    activity.take(event("session.tool.called", { sessionID: SESSION, id: "call-1" }))
    activity.take(event("session.tool.called", { sessionID: "ses_other", id: "call-2" }))
    expect(activity.level([SESSION])).toBeCloseTo(1 - Math.exp(-0.3), 4)
    expect(activity.level(["ses_other"])).toBeCloseTo(1 - Math.exp(-0.3), 4)
    expect(activity.level(["ses_nobody"])).toBe(0)
    activity.dispose()
  })

  test("unweighted events do not heat the network", () => {
    const activity = new NeuralActivity()
    activity.take(event("session.created", { sessionID: SESSION }))
    expect(activity.level()).toBe(0)
    activity.dispose()
  })

  test("many tool calls push the level towards 1", () => {
    const activity = new NeuralActivity()

    for (let i = 0; i < 10; i++) {
      activity.take(event("session.tool.called", { sessionID: SESSION, id: `call-${i}` }))
    }

    expect(activity.level()).toBeGreaterThan(0.9)
    activity.dispose()
  })

  test("the signal ring reports actions after a cursor", () => {
    const activity = new NeuralActivity()
    activity.take(event("session.tool.called", { sessionID: SESSION, id: "call-1" }))
    const cursor = activity.cursor
    activity.take(event("session.step.started", { sessionID: SESSION }))
    const signals = activity.since(cursor)
    expect(signals).toHaveLength(1)
    expect(signals[0].kind).toBe("step")
    expect(activity.since(activity.cursor)).toHaveLength(0)
    activity.dispose()
  })

  test("streaming text deltas produce at most one write signal per beat", () => {
    const activity = new NeuralActivity()
    activity.take(event("session.text.delta", { sessionID: SESSION }))
    activity.take(event("session.text.delta", { sessionID: SESSION }))
    activity.take(event("session.text.delta", { sessionID: SESSION }))
    const writes = activity.since(0).filter((signal) => signal.kind === "write")
    expect(writes).toHaveLength(1)
    activity.dispose()
  })

  test("a finished tool call carries the tool name from its start", () => {
    const activity = new NeuralActivity()
    activity.take(event("session.tool.input.started", { sessionID: SESSION, id: "call-1", name: "read" }))
    activity.take(event("session.tool.success", { sessionID: SESSION, id: "call-1" }))
    const done = activity.since(0).find((signal) => signal.kind === "done")
    expect(done?.label).toBe("read")
    activity.dispose()
  })

  test("heat cools with a half-life of a couple of seconds", async () => {
    const activity = new NeuralActivity()

    for (let i = 0; i < 10; i++) {
      activity.take(event("session.tool.called", { sessionID: SESSION, id: `call-${i}` }))
    }

    const hot = activity.level()
    expect(hot).toBeGreaterThan(0.9)
    await Bun.sleep(2600)
    // The level saturates (1 - exp(-heat/10)), so it falls slower than the
    // heat itself: heat 30 -> ~10 after 2.6s (half-life 2.4s), level
    // 0.95 -> ~0.64. It must clearly decay, but stay warm.
    expect(activity.level()).toBeLessThan(0.68)
    expect(activity.level()).toBeGreaterThan(0.5)
    activity.dispose()
  }, 10000)
})

describe("neuralEnergyFloor", () => {
  test("a quiet network has a small floor, each running session adds to it", () => {
    expect(neuralEnergyFloor(0)).toBe(0.02)
    expect(neuralEnergyFloor(1)).toBeCloseTo(0.18, 5)
    expect(neuralEnergyFloor(3)).toBeCloseTo(0.3, 5)
  })
})

test("neural canvases need no activity timer; text subscribers own one shared timer", () => {
  const interval = spyOn(globalThis, "setInterval")
  const clear = spyOn(globalThis, "clearInterval")
  const activity = new NeuralActivity()

  try {
    expect(interval).not.toHaveBeenCalled()
    activity.take(event("session.tool.called", { sessionID: SESSION, id: "lazy-call" }))
    expect(activity.pulse).toBeGreaterThan(0)
    expect(interval).not.toHaveBeenCalled()
    const first = activity.subscribePulse(() => undefined)
    const second = activity.subscribePulse(() => undefined)
    expect(interval).toHaveBeenCalledTimes(1)
    first()
    expect(clear).not.toHaveBeenCalled()
    second()
    expect(clear).toHaveBeenCalledTimes(1)
  } finally {
    activity.dispose()
    interval.mockRestore()
    clear.mockRestore()
  }
})
