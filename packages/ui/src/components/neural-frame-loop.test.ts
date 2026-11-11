import { describe, expect, test } from "bun:test"
import { createNeuralFrameLoop } from "./neural-frame-loop"

function harness() {
  let next = 0
  const frames = new Map<number, (now: number) => void>()
  const draws: number[] = []

  const loop = createNeuralFrameLoop({
    request(callback) {
      frames.set(++next, callback)

      return next
    },
    cancel(id) {
      frames.delete(id)
    },
    draw: (dt) => draws.push(dt),
  })

  return {
    loop,
    frames,
    draws,
    tick(now: number) {
      const entries = [...frames]
      frames.clear()
      entries.forEach(([, callback]) => callback(now))
    },
  }
}

const active = { motion: true, visible: true, hidden: false }

describe("neural canvas frame ownership", () => {
  test("schedules one frame and bounds elapsed time after a slow frame", () => {
    const h = harness()
    h.loop.update(active)
    h.loop.update(active)
    expect(h.frames.size).toBe(1)
    h.tick(1000)
    h.tick(1016)
    h.tick(8016)
    expect(h.draws).toEqual([0, 0.016, 0.1])
    expect(h.frames.size).toBe(1)
    h.loop.dispose()
    expect(h.frames.size).toBe(0)
  })

  test.each(["offscreen", "hidden"])("stops all RAF scheduling while %s, resumes without a jump", (pause) => {
    const h = harness()
    h.loop.update(active)
    h.tick(1000)
    h.loop.update({ ...active, visible: pause !== "offscreen", hidden: pause === "hidden" })
    expect(h.frames.size).toBe(0)
    h.tick(9000)
    expect(h.draws).toEqual([0])
    h.loop.redraw()
    expect(h.draws).toEqual([0])
    h.loop.update(active)
    expect(h.frames.size).toBe(1)
    h.tick(10000)
    expect(h.draws).toEqual([0, 0])
    h.loop.dispose()
  })

  test("Animations off draws a static frame, and resize/theme redraws do not start a timer", () => {
    const h = harness()
    h.loop.update(active)
    h.tick(1000)
    h.loop.update({ ...active, motion: false })
    expect(h.frames.size).toBe(0)
    expect(h.draws).toEqual([0, 0])
    h.loop.redraw()
    expect(h.draws).toEqual([0, 0, 0])
    expect(h.frames.size).toBe(0)
    h.loop.update(active)
    expect(h.frames.size).toBe(1)
    h.loop.dispose()
  })

  test("dispose cannot be undone by a late visibility, motion or theme event", () => {
    const h = harness()
    h.loop.update(active)
    h.loop.dispose()
    h.loop.update(active)
    h.loop.redraw()
    expect(h.frames.size).toBe(0)
    expect(h.draws).toEqual([])
  })
})
