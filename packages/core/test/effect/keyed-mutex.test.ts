import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Option } from "effect"
import { KeyedMutex } from "@orchestra/core/effect/keyed-mutex"
import { it } from "../lib/effect"

describe("KeyedMutex", () => {
  it.effect("serializes effects with the same key", () =>
    Effect.gen(function* () {
      const mutex = yield* KeyedMutex.make<string>()
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()

      const first = yield* mutex
        .withLock("shared")(
          Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst))),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      const second = yield* mutex.withLock("shared")(Deferred.succeed(secondStarted, undefined)).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(secondStarted)).toBe(false)

      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(yield* mutex.size).toBe(0)
    }),
  )

  it.effect("allows different keys to proceed independently", () =>
    Effect.gen(function* () {
      const mutex = yield* KeyedMutex.make<string>()
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const secondFinished = yield* Deferred.make<void>()

      const first = yield* mutex
        .withLock("first")(Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      yield* mutex.withLock("second")(Deferred.succeed(secondFinished, undefined))
      expect(yield* Deferred.isDone(secondFinished)).toBe(true)

      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      expect(yield* mutex.size).toBe(0)
    }),
  )

  it.effect("removes an interrupted waiter without dropping the holder lock", () =>
    Effect.gen(function* () {
      const mutex = yield* KeyedMutex.make<string>()
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()

      const first = yield* mutex
        .withLock("shared")(
          Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst))),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      const interrupted = yield* mutex.withLock("shared")(Effect.void).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(interrupted)
      expect(yield* mutex.size).toBe(1)

      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      expect(yield* mutex.size).toBe(0)
    }),
  )

  it.effect("skips work when the key is held instead of waiting for it", () =>
    Effect.gen(function* () {
      const mutex = yield* KeyedMutex.make<string>()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const holder = yield* mutex
        .withLock("busy")(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      let ran = false
      const skipped = yield* mutex.tryWithLock("busy")(
        Effect.sync(() => {
          ran = true
        }),
      )
      expect(Option.isNone(skipped)).toBe(true)
      expect(ran).toBe(false)
      expect(Option.getOrThrow(yield* mutex.tryWithLock("free")(Effect.succeed("done")))).toBe("done")

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
      expect(yield* mutex.size).toBe(0)
    }),
  )

  it.effect("releases the key when the holder is interrupted", () =>
    Effect.gen(function* () {
      const mutex = yield* KeyedMutex.make<string>()
      const started = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()

      const holder = yield* mutex
        .withLock("shared")(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(never))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(holder)

      // A crashed run must not strand the key: the next owner proceeds without a release.
      const value = yield* mutex.withLock("shared")(Effect.succeed("next"))
      expect(value).toBe("next")
      expect(yield* mutex.size).toBe(0)
    }),
  )

  it.effect("hands the key to a waiter after the holder is interrupted", () =>
    Effect.gen(function* () {
      const mutex = yield* KeyedMutex.make<string>()
      const started = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      const waiterRan = yield* Deferred.make<void>()

      const holder = yield* mutex
        .withLock("shared")(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(never))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const waiter = yield* mutex.withLock("shared")(Deferred.succeed(waiterRan, undefined)).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(waiterRan)).toBe(false)

      yield* Fiber.interrupt(holder)
      yield* Fiber.join(waiter)
      expect(yield* Deferred.isDone(waiterRan)).toBe(true)
      expect(yield* mutex.size).toBe(0)
    }),
  )

  it.effect("releases the key when the holder dies", () =>
    Effect.gen(function* () {
      const mutex = yield* KeyedMutex.make<string>()
      const started = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()

      const holder = yield* mutex
        .withLock("shared")(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(never))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const dying = yield* mutex
        .withLock("shared")(Effect.die(new Error("boom")))
        .pipe(Effect.forkChild)
      yield* Fiber.interrupt(holder)
      expect((yield* Fiber.join(dying).pipe(Effect.exit))._tag).toBe("Failure")

      expect(yield* mutex.withLock("shared")(Effect.succeed("next"))).toBe("next")
      expect(yield* mutex.size).toBe(0)
    }),
  )

  it.effect("never overlaps holders of one key under concurrent load", () =>
    Effect.gen(function* () {
      const mutex = yield* KeyedMutex.make<string>()
      let active = 0
      let peak = 0
      const work = Effect.sync(() => {
        active++
        peak = Math.max(peak, active)
      }).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.ensuring(
          Effect.sync(() => {
            active--
          }),
        ),
      )

      yield* Effect.forEach(
        Array.from({ length: 25 }, (_, index) => index),
        () => mutex.withLock("shared")(work),
        {
          concurrency: "unbounded",
          discard: true,
        },
      )
      expect(peak).toBe(1)
      expect(active).toBe(0)
      expect(yield* mutex.size).toBe(0)
    }),
  )

  it.effect("coalesces concurrent tryWithLock calls onto a single slot", () =>
    Effect.gen(function* () {
      const mutex = yield* KeyedMutex.make<string>()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const holder = yield* mutex
        .withLock("busy")(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const attempts = yield* Effect.forEach(
        Array.from({ length: 10 }, (_, index) => index),
        () => mutex.tryWithLock("busy")(Effect.succeed(true)),
        { concurrency: "unbounded" },
      )
      expect(attempts.every(Option.isNone)).toBe(true)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
      expect(yield* mutex.size).toBe(0)
    }),
  )
})
