import { describe, expect, test } from "bun:test"
import {
  AUTO_ROTATION_COOLDOWN_MS,
  AUTO_ROTATION_LIMIT,
  AUTO_ROTATION_LIMIT_WINDOW_MS,
  createRotationGate,
  describeAutoRotation,
  INEFFECTIVE_ROTATION_MAX_WINDOW_MS,
  INEFFECTIVE_ROTATION_WINDOW_MS,
} from "../../src/feature-plugins/system/warp-rotation"

describe("WARP automatic rotation gate", () => {
  test("lets the first limit error rotate at once", () => {
    expect(createRotationGate(() => 1_000).decide()).toEqual({ run: true })
  })

  test("holds a second failure until the cooldown has passed", () => {
    let time = 1_000
    const gate = createRotationGate(() => time)
    gate.started()
    gate.finished(true)
    time += 10_000

    expect(gate.decide()).toEqual({ run: false, reason: "cooldown", retryIn: AUTO_ROTATION_COOLDOWN_MS - 10_000 })
    time += AUTO_ROTATION_COOLDOWN_MS
    expect(gate.decide()).toEqual({ run: true })
  })

  test("stops after the rotation ceiling and reopens when the window slides", () => {
    let time = 0
    const gate = createRotationGate(() => time)
    for (let index = 0; index < AUTO_ROTATION_LIMIT; index++) {
      expect(gate.decide().run).toBe(true)
      gate.started()
      gate.finished(true)
      time += AUTO_ROTATION_COOLDOWN_MS
    }

    expect(gate.decide()).toEqual({ run: false, reason: "limit", until: AUTO_ROTATION_LIMIT_WINDOW_MS })
    time = AUTO_ROTATION_LIMIT_WINDOW_MS
    expect(gate.decide()).toEqual({ run: true })
  })

  test("backs the tunnel off after a rotation that kept the address, doubling up to the ceiling", () => {
    let time = 0
    const gate = createRotationGate(() => time)
    const windows: number[] = []
    for (let index = 0; index < 5; index++) {
      gate.started()
      gate.finished(false)
      const decision = gate.decide()
      if (decision.run || decision.reason !== "unchanged") throw new Error("expected an unchanged-address pause")
      windows.push(decision.until - time)
      time = decision.until
    }

    expect(windows).toEqual([
      INEFFECTIVE_ROTATION_WINDOW_MS,
      INEFFECTIVE_ROTATION_WINDOW_MS * 2,
      INEFFECTIVE_ROTATION_MAX_WINDOW_MS,
      INEFFECTIVE_ROTATION_MAX_WINDOW_MS,
      INEFFECTIVE_ROTATION_MAX_WINDOW_MS,
    ])
  })

  test("a new address clears the backoff", () => {
    let time = 0
    const gate = createRotationGate(() => time)
    gate.started()
    gate.finished(false)
    time = INEFFECTIVE_ROTATION_WINDOW_MS
    gate.started()
    gate.finished(true)
    time += AUTO_ROTATION_COOLDOWN_MS
    gate.started()
    gate.finished(false)

    expect(gate.decide()).toEqual({ run: false, reason: "unchanged", until: time + INEFFECTIVE_ROTATION_WINDOW_MS })
  })

  test("never allows more rotations than the ceiling however many failures arrive", () => {
    let time = 0
    const gate = createRotationGate(() => time)
    let rotations = 0
    // A failure every second for ten minutes, each rotation handing out a fresh address.
    for (; time < AUTO_ROTATION_LIMIT_WINDOW_MS; time += 1_000) {
      if (!gate.decide().run) continue
      gate.started()
      gate.finished(true)
      rotations++
    }

    expect(rotations).toBe(AUTO_ROTATION_LIMIT)
  })
})

describe("WARP automatic rotation status", () => {
  test("stays hidden until Auto IP has done something", () => {
    expect(describeAutoRotation({ phase: "idle" }, true)).toBe("")
  })

  test("names the switch from one address to the next", () => {
    const text = describeAutoRotation({ phase: "changed", at: 0, from: "104.28.1.1", to: "104.28.2.2" }, false)
    expect(text.startsWith("104.28.1.1 → 104.28.2.2 · ")).toBe(true)
  })

  test("says why Auto IP is waiting", () => {
    expect(describeAutoRotation({ phase: "rotating", at: 0 }, true)).toBe("смена IP…")
    expect(describeAutoRotation({ phase: "paused", at: 0, reason: "unchanged", until: 0 }, true)).toStartWith("IP тот же")
    expect(describeAutoRotation({ phase: "paused", at: 0, reason: "limit", until: 0 }, false)).toStartWith("rotation cap")
  })
})
