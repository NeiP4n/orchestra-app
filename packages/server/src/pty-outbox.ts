export * as PtyOutbox from "./pty-outbox"

import { Deferred, Effect, Exit, Queue } from "effect"
import { Socket } from "effect/unstable/socket"

/**
 * A PTY socket outbox bounded by both frame count and buffered bytes.
 *
 * The producer is the native PTY data callback, which cannot be paused or awaited, so the only
 * way to keep memory finite is to stop accepting frames once the budget is spent and tell the
 * reader to resync. `offer` therefore never blocks and never drops silently: the first refused
 * frame latches the outbox into the overflow state, `awaitOverflow` wakes the drain loop, and the
 * route closes the socket with `OverflowCode` so the client reconnects from its cursor instead of
 * losing output without notice.
 */
export type Frame = string | Uint8Array | Socket.CloseEvent

/** 1013 means "try again later"; clients reconnect and resume from the cursor they already know. */
export const OverflowCode = 1013
export const OverflowReason = "terminal output backlog overflow; reconnect to resync"

/** Replay is delivered through the same outbox, so the budget must fit a full retained PTY buffer. */
export const DefaultCapacityBytes = 16 * 1024 * 1024
export const DefaultCapacityFrames = 8_192

export const frameBytes = (frame: Frame) =>
  typeof frame === "string" ? Buffer.byteLength(frame) : frame instanceof Uint8Array ? frame.byteLength : 0

export interface Options {
  readonly capacityBytes?: number
  readonly capacityFrames?: number
}

export interface Interface {
  /** Enqueues the frame, or returns false once the budget is exhausted (latched until shutdown). */
  readonly offer: (frame: Frame) => boolean
  readonly take: Effect.Effect<Frame>
  readonly overflowed: Effect.Effect<boolean>
  readonly bufferedBytes: Effect.Effect<number>
  /** Resolves once the budget is exhausted, so a blocked drain loop can stop and close. */
  readonly awaitOverflow: Effect.Effect<void>
  readonly shutdown: Effect.Effect<void>
}

const positive = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback

export const make = (options: Options = {}): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const capacityBytes = positive(options.capacityBytes, DefaultCapacityBytes)
    const capacityFrames = positive(options.capacityFrames, DefaultCapacityFrames)
    const queue = yield* Queue.bounded<Frame>(capacityFrames)
    const overflow = yield* Deferred.make<void>()
    let buffered = 0
    let closed = false

    return {
      offer: (frame) => {
        if (closed) return false
        const size = frameBytes(frame)
        if (buffered + size > capacityBytes || !Queue.offerUnsafe(queue, frame)) {
          closed = true
          Deferred.doneUnsafe(overflow, Exit.void)
          return false
        }
        buffered += size
        return true
      },
      take: Queue.take(queue).pipe(
        Effect.tap((frame) =>
          Effect.sync(() => {
            buffered -= frameBytes(frame)
          }),
        ),
      ),
      overflowed: Effect.sync(() => closed),
      bufferedBytes: Effect.sync(() => buffered),
      awaitOverflow: Deferred.await(overflow),
      shutdown: Queue.shutdown(queue).pipe(Effect.asVoid),
    }
  })
