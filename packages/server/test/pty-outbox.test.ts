import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Socket } from "effect/unstable/socket"
import { PtyOutbox } from "../src/pty-outbox"

const make = (options?: PtyOutbox.Options) => Effect.runSync(PtyOutbox.make(options))

describe("PtyOutbox", () => {
  test("keeps FIFO order and releases bytes as frames are written", async () => {
    const outbox = make({ capacityBytes: 64 })
    expect(outbox.offer("abc")).toBe(true)
    expect(outbox.offer("de")).toBe(true)
    expect(await Effect.runPromise(outbox.bufferedBytes)).toBe(5)

    expect(await Effect.runPromise(outbox.take)).toBe("abc")
    expect(await Effect.runPromise(outbox.bufferedBytes)).toBe(2)
    expect(await Effect.runPromise(outbox.take)).toBe("de")
    expect(await Effect.runPromise(outbox.bufferedBytes)).toBe(0)
    expect(await Effect.runPromise(outbox.overflowed)).toBe(false)
  })

  test("counts UTF-8 bytes, not characters", async () => {
    const outbox = make({ capacityBytes: 6 })
    // "привет" is six characters but twelve UTF-8 bytes.
    expect(outbox.offer("привет")).toBe(false)
    expect(await Effect.runPromise(outbox.bufferedBytes)).toBe(0)
    expect(await Effect.runPromise(outbox.overflowed)).toBe(true)
  })

  test("refuses a frame that would exceed the byte budget and signals overflow", async () => {
    const outbox = make({ capacityBytes: 8 })
    expect(outbox.offer("12345")).toBe(true)
    expect(outbox.offer("6789")).toBe(false)
    expect(await Effect.runPromise(outbox.overflowed)).toBe(true)
    await Effect.runPromise(outbox.awaitOverflow)
    expect(outbox.offer("x")).toBe(false)
    // Frames accepted before the overflow stay readable, so the explicit close can be ordered after them.
    expect(await Effect.runPromise(outbox.take)).toBe("12345")
  })

  test("refuses a single frame larger than the whole budget without buffering it", async () => {
    const outbox = make({ capacityBytes: 1024 })
    expect(outbox.offer("x".repeat(1025))).toBe(false)
    expect(await Effect.runPromise(outbox.bufferedBytes)).toBe(0)
    expect(await Effect.runPromise(outbox.overflowed)).toBe(true)
  })

  test("enforces the frame budget even when bytes are small", async () => {
    const outbox = make({ capacityBytes: 4096, capacityFrames: 2 })
    expect(outbox.offer("a")).toBe(true)
    expect(outbox.offer("b")).toBe(true)
    expect(outbox.offer("c")).toBe(false)
    expect(await Effect.runPromise(outbox.overflowed)).toBe(true)
  })

  test("a stalled consumer cannot grow the buffer past its budget", async () => {
    const outbox = make({ capacityBytes: 1_024, capacityFrames: 8 })
    let accepted = 0
    for (let index = 0; index < 10_000; index++) if (outbox.offer("x".repeat(100))) accepted++

    expect(accepted).toBeLessThan(10_000)
    expect(await Effect.runPromise(outbox.bufferedBytes)).toBeLessThanOrEqual(1_024)
    expect(await Effect.runPromise(outbox.overflowed)).toBe(true)
  })

  test("control frames do not consume the byte budget", async () => {
    const outbox = make({ capacityBytes: 1 })
    expect(outbox.offer(new Socket.CloseEvent(PtyOutbox.OverflowCode, PtyOutbox.OverflowReason))).toBe(true)
    expect(await Effect.runPromise(outbox.bufferedBytes)).toBe(0)
    expect(await Effect.runPromise(outbox.take)).toBeInstanceOf(Socket.CloseEvent)
  })

  test("shutdown releases buffered frames and ends a blocked take", async () => {
    const outbox = make({ capacityBytes: 64 })
    expect(outbox.offer("abc")).toBe(true)
    await Effect.runPromise(outbox.shutdown)
    const exit = await Effect.runPromise(Effect.exit(outbox.take))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
