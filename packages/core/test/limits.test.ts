import { describe, expect, test } from "bun:test"
import { Limits } from "../src/limits"

const off = {}
const on = { ORCHESTRA_ENFORCE_LIMITS: "1" }

describe("Limits", () => {
  test("is unlimited unless enforcement is requested", () => {
    expect(Limits.enforced(off)).toBe(false)
    expect(Limits.enforced({ ORCHESTRA_ENFORCE_LIMITS: "0" })).toBe(false)
    expect(Limits.enforced(on)).toBe(true)
    expect(Limits.enforced({ ORCHESTRA_ENFORCE_LIMITS: "true" })).toBe(true)
  })

  test("ignores step ceilings by default", () => {
    expect(Limits.steps([5, 3], off)).toBeUndefined()
  })

  test("the smaller step ceiling wins when enforced", () => {
    expect(Limits.steps([5, 3], on)).toBe(3)
    expect(Limits.steps([undefined, 7], on)).toBe(7)
    expect(Limits.steps([undefined, undefined], on)).toBeUndefined()
  })

  test("timeouts are effectively unbounded by default", () => {
    expect(Limits.timeout(undefined, 1000, off)).toBe(Limits.UNBOUNDED_MS)
    expect(Limits.UNBOUNDED_MS).toBeGreaterThan(24 * 24 * 60 * 60 * 1000)
  })

  test("explicit timeouts always apply and the fallback applies when enforced", () => {
    expect(Limits.timeout(500, 1000, off)).toBe(500)
    expect(Limits.timeout(undefined, 1000, on)).toBe(1000)
    expect(Limits.timeout(500, 1000, on)).toBe(500)
  })
})
