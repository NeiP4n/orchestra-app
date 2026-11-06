import { describe, expect, test } from "bun:test"
import {
  REPEAT_STOP_CONSECUTIVE,
  REPEAT_STOP_WINDOW,
  REPEAT_WINDOW_MS,
  fingerprintError,
  normalizeError,
  parseHistory,
  recordRepeat,
} from "@orchestra/core/autoloop/kernel/repeat"

const T0 = Date.parse("2026-11-05T21:00:00.000Z")
const MINUTE = 60_000

describe("AutoloopRepeat fingerprint", () => {
  test("the same error with different numbers, paths and timestamps has one fingerprint", () => {
    const first = fingerprintError("connect ECONNREFUSED 127.0.0.1:5432 at 2026-11-05T21:00:00Z (pid 1234)")
    const second = fingerprintError("connect ECONNREFUSED 127.0.0.1:17890 at 2026-11-05T21:05:00Z (pid 9876)")
    expect(first).toBe(second)
    expect(normalizeError("Error in /tmp/work-abc/file.ts line 42")).toBe("error in <path> line <n>")
  })

  test("different errors have different fingerprints", () => {
    expect(fingerprintError("database is locked")).not.toBe(fingerprintError("port already in use"))
    expect(fingerprintError("")).not.toBe(fingerprintError("database is locked"))
  })

  test("garbage history parses as empty", () => {
    expect(parseHistory(null)).toEqual([])
    expect(parseHistory("not json")).toEqual([])
    expect(parseHistory(JSON.stringify([{ fp: "ab", at: "soon" }]))).toEqual([])
  })
})

describe("AutoloopRepeat recordRepeat", () => {
  test("three in a row is stuck", () => {
    const fp = fingerprintError("database is locked")
    const first = recordRepeat(null, fp, T0)
    const second = recordRepeat(JSON.stringify(first.history), fp, T0 + MINUTE)
    const third = recordRepeat(JSON.stringify(second.history), fp, T0 + 2 * MINUTE)

    expect(first.stuck).toBe(false)
    expect(first.consecutive).toBe(1)
    expect(second.stuck).toBe(false)
    expect(third.stuck).toBe(true)
    expect(third.consecutive).toBe(REPEAT_STOP_CONSECUTIVE)
  })

  test("a different error resets the consecutive count but not the window", () => {
    const locked = fingerprintError("database is locked")
    const busy = fingerprintError("port already in use")
    const first = recordRepeat(null, locked, T0)
    const other = recordRepeat(JSON.stringify(first.history), busy, T0 + MINUTE)
    const again = recordRepeat(JSON.stringify(other.history), locked, T0 + 2 * MINUTE)

    expect(other.consecutive).toBe(1)
    expect(again.consecutive).toBe(1)
    expect(again.inWindow).toBe(2)
    expect(again.stuck).toBe(false)
  })

  test("three of the same within an hour is stuck even when not consecutive", () => {
    const fp = fingerprintError("database is locked")
    const other = fingerprintError("port already in use")
    let stored: string | null = null
    let status = recordRepeat(stored, fp, T0)
    stored = JSON.stringify(status.history)
    status = recordRepeat(stored, other, T0 + 10 * MINUTE)
    stored = JSON.stringify(status.history)
    status = recordRepeat(stored, fp, T0 + 20 * MINUTE)
    stored = JSON.stringify(status.history)
    status = recordRepeat(stored, other, T0 + 30 * MINUTE)
    stored = JSON.stringify(status.history)
    status = recordRepeat(stored, fp, T0 + 40 * MINUTE)

    expect(status.consecutive).toBe(1)
    expect(status.inWindow).toBe(REPEAT_STOP_WINDOW)
    expect(status.stuck).toBe(true)
  })

  test("occurrences older than an hour do not count toward the window", () => {
    const fp = fingerprintError("database is locked")
    const other = fingerprintError("port already in use")
    const first = recordRepeat(null, fp, T0)
    const second = recordRepeat(JSON.stringify(first.history), other, T0 + REPEAT_WINDOW_MS)
    const third = recordRepeat(JSON.stringify(second.history), fp, T0 + 2 * REPEAT_WINDOW_MS)
    const fourth = recordRepeat(JSON.stringify(third.history), other, T0 + 2 * REPEAT_WINDOW_MS + MINUTE)
    const fifth = recordRepeat(JSON.stringify(fourth.history), fp, T0 + 2 * REPEAT_WINDOW_MS + 2 * MINUTE)

    expect(fifth.consecutive).toBe(1)
    expect(fifth.inWindow).toBe(2)
    expect(fifth.stuck).toBe(false)
  })

  test("history keeps only the last ten occurrences", () => {
    let stored: string | null = null
    let status = recordRepeat(stored, fingerprintError("database is locked"), T0)
    for (let index = 1; index < 12; index++) {
      status = recordRepeat(JSON.stringify(status.history), fingerprintError(`error ${index}`), T0 + index * MINUTE)
    }
    expect(status.history).toHaveLength(10)
  })
})
