export * as EventFeed from "./event-feed"

import { Bus } from "@orchestra/core/bus"
import { Event } from "@orchestra/schema/event"
import { isOrchestraEvent, type OrchestraEvent } from "@orchestra/protocol/groups/event"
import { Cause, Context, Duration, Effect, Layer, Queue, Schema, Scope, Stream } from "effect"

export const SubscriberCapacity = 256
/**
 * Frames are not equal: one tool result or diff can dwarf a hundred deltas. The frame cap alone
 * therefore cannot bound a slow client's memory, so every subscriber also has a byte budget.
 */
export const SubscriberCapacityBytes = 1 * 1024 * 1024
/**
 * Events kept for replay after a reconnect. 512 frames covered a few seconds of
 * token deltas; a 30-second network drop at full streaming rate blows past it
 * and silently loses events, so the window holds 4096 frames instead.
 */
export const DefaultReplayCapacity = 4096
export const DefaultHeartbeatInterval = "15 seconds"
export const HeartbeatFrame = ": heartbeat\n\n"

/**
 * Classifies whether an event is a critical lifecycle event (session status, step completion, errors)
 * that must be reliably delivered without being dropped during high-frequency token streaming.
 */
export function isCriticalEvent(event: { readonly type?: string }): boolean {
  const type = (event.type ?? "").toLowerCase()
  if (type === "session.status" || type.endsWith(".status")) return true
  if (
    type.includes("step.finish") ||
    type.includes("step-finish") ||
    type.includes("step.ended") ||
    type.includes("step.failed") ||
    type.endsWith(".finish") ||
    type.endsWith(".ended")
  ) {
    return true
  }
  if (type.includes("error") || type.includes("failed") || type.endsWith(".error")) return true
  if (
    type.startsWith("session.") &&
    (type.endsWith(".idle") ||
      type.endsWith(".busy") ||
      type.endsWith(".retry") ||
      type.endsWith(".created") ||
      type.endsWith(".deleted") ||
      type.endsWith(".interrupted") ||
      type.includes(".execution."))
  ) {
    return true
  }
  if (type.startsWith("permission.")) return true
  return false
}

export class SubscriberOverflowError extends Schema.TaggedError<SubscriberOverflowError>()(
  "EventFeed.SubscriberOverflow",
  { capacity: Schema.Int, bytes: Schema.Int.pipe(Schema.optional) },
) {}

export class EncodingError extends Schema.TaggedError<EncodingError>()("EventFeed.EncodingError", {
  eventID: Event.ID,
  eventType: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Error = SubscriberOverflowError | EncodingError

export interface SubscribeOptions {
  readonly lastEventID?: string
  readonly heartbeatInterval?: Duration.Input | false
}

/**
 * Fixed-capacity ring of encoded frames. `head` points at the oldest retained frame, so
 * appending and evicting are O(1) instead of shifting the whole array on every event,
 * which the live feed does once per published event at high delta rates.
 */
export class EventRingBuffer {
  private readonly items: Array<{ readonly id: string; readonly encoded: string } | undefined>
  private head = 0
  private count = 0

  constructor(readonly capacity: number) {
    this.items = new Array(Math.max(0, capacity))
  }

  push(item: { readonly id: string; readonly encoded: string }) {
    if (this.capacity <= 0) return
    this.items[(this.head + this.count) % this.capacity] = item
    if (this.count === this.capacity) this.head = (this.head + 1) % this.capacity
    else this.count++
  }

  replaySince(lastEventID: string): ReadonlyArray<string> | undefined {
    for (let offset = 0; offset < this.count; offset++) {
      const item = this.items[(this.head + offset) % this.capacity]
      if (!item || item.id !== lastEventID) continue
      const frames = new Array<string>(this.count - offset - 1)
      for (let index = offset + 1; index < this.count; index++)
        frames[index - offset - 1] = this.items[(this.head + index) % this.capacity]!.encoded
      return frames
    }
    return undefined
  }

  get size(): number {
    return this.count
  }
}

export interface Interface {
  readonly subscribe: Effect.Effect<Stream.Stream<string, Error>, never, Scope.Scope> &
    ((options?: SubscribeOptions) => Effect.Effect<Stream.Stream<string, Error>, never, Scope.Scope>)
  readonly stream: (options?: SubscribeOptions) => Effect.Effect<Stream.Stream<string, Error>, never, Scope.Scope>
  readonly replaySince: (lastEventID: string) => ReadonlyArray<string> | undefined
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/server/EventFeed") {}

export function frame(event: OrchestraEvent, options?: { readonly id?: boolean }) {
  if (options?.id) {
    return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`
  }
  return `data: ${JSON.stringify(event)}\n\n`
}

export const make = Effect.fn("EventFeed.make")(function* (
  observe: (subscriber: Bus.Subscriber) => Effect.Effect<Bus.Unsubscribe>,
  options?: {
    readonly capacity?: number
    readonly capacityBytes?: number
    readonly replayCapacity?: number
    readonly heartbeatInterval?: Duration.Input | false
    readonly encode?: (event: OrchestraEvent) => string
  },
) {
  const capacity = options?.capacity ?? SubscriberCapacity
  const capacityBytes = options?.capacityBytes ?? SubscriberCapacityBytes
  const replayCapacity = options?.replayCapacity ?? DefaultReplayCapacity
  const defaultHeartbeat = options?.heartbeatInterval ?? false
  const render = options?.encode ?? frame
  const ringBuffer = new EventRingBuffer(replayCapacity)

  interface SubscriberSlot {
    readonly queue: Queue.Queue<string, Error>
    readonly criticalQueue: Queue.Queue<string, Error>
  }

  const subscribers = new Set<SubscriberSlot>()
  // Undelivered bytes per subscriber, decremented as the stream is consumed.
  const buffered = new Map<SubscriberSlot, number>()
  const byteLength = (encoded: string) => Buffer.byteLength(encoded)

  const fail = (error: Error) =>
    Effect.sync(() => {
      const current = Array.from(subscribers)
      subscribers.clear()
      for (const subscriber of current) {
        Queue.failCauseUnsafe(subscriber.queue, Cause.fail(error))
        Queue.failCauseUnsafe(subscriber.criticalQueue, Cause.fail(error))
      }
    })

  const publish = Effect.fnUntraced(function* (event: Event.Payload) {
    if (!isOrchestraEvent(event)) return
    if (subscribers.size === 0 && replayCapacity <= 0) return
    const encoded = yield* Effect.try({
      try: () => render(event),
      catch: (cause) => new EncodingError({ eventID: event.id, eventType: event.type, cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("Failed to encode public event", {
          eventID: error.eventID,
          eventType: error.eventType,
          cause: error.cause,
        }).pipe(Effect.andThen(fail(error)), Effect.as(undefined)),
      ),
    )
    if (encoded === undefined) return
    ringBuffer.push({ id: event.id, encoded })
    const size = byteLength(encoded)
    const isCritical = isCriticalEvent(event)

    for (const subscriber of subscribers) {
      if (isCritical) {
        // Critical lifecycle events (session.status, step.finish, error) bypass normal
        // ephemeral token congestion and are reliably delivered to the subscriber.
        Queue.offerUnsafe(subscriber.criticalQueue, encoded)
        continue
      }

      const used = buffered.get(subscriber) ?? 0
      // Refuse before the frame lands: exceeding the budget by one huge frame must not be stored.
      if (used + size > capacityBytes) {
        subscribers.delete(subscriber)
        buffered.delete(subscriber)
        Queue.failCauseUnsafe(
          subscriber.queue,
          Cause.fail(new SubscriberOverflowError({ capacity, bytes: used + size })),
        )
        continue
      }
      if (!Queue.offerUnsafe(subscriber.queue, encoded)) {
        subscribers.delete(subscriber)
        buffered.delete(subscriber)
        Queue.failCauseUnsafe(subscriber.queue, Cause.fail(new SubscriberOverflowError({ capacity, bytes: used })))
        continue
      }
      buffered.set(subscriber, used + size)
    }
  })

  const unsubscribe = yield* observe(publish)
  yield* Effect.addFinalizer(() => unsubscribe)

  const createSubscription = (subOptions?: SubscribeOptions) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const queue = yield* Queue.dropping<string, Error>(capacity)
        const criticalQueue = yield* Queue.dropping<string, Error>(capacity)
        const slot: SubscriberSlot = { queue, criticalQueue }
        subscribers.add(slot)
        buffered.set(slot, 0)
        return slot
      }),
      (slot) =>
        Effect.sync(() => {
          subscribers.delete(slot)
          buffered.delete(slot)
        }).pipe(
          Effect.andThen(Queue.shutdown(slot.queue)),
          Effect.andThen(Queue.shutdown(slot.criticalQueue)),
          Effect.asVoid,
        ),
    ).pipe(
      Effect.map((slot) => {
        const regularStream = Stream.fromQueue(slot.queue).pipe(
          Stream.tap((frame) =>
            Effect.sync(() => {
              const used = buffered.get(slot) ?? 0
              buffered.set(slot, Math.max(0, used - byteLength(frame)))
            }),
          ),
        )
        const criticalStream = Stream.fromQueue(slot.criticalQueue)
        const liveStream = Stream.merge(criticalStream, regularStream)
        const replayFrames = subOptions?.lastEventID ? ringBuffer.replaySince(subOptions.lastEventID) : undefined
        // The client's last event fell out of the replay window (a long disconnect or a
        // server restart): say so up front instead of silently resuming live, so the
        // client resyncs from the API instead of showing a session that quietly lost events.
        const replayGap =
          subOptions?.lastEventID !== undefined && replayFrames === undefined
            ? frame(
                {
                  id: Event.ID.create(),
                  created: Date.now(),
                  type: "server.replay-gap",
                  data: { lastEventID: subOptions.lastEventID },
                },
                { id: true },
              )
            : undefined
        const baseStream =
          replayFrames && replayFrames.length > 0
            ? Stream.concat(Stream.fromIterable(replayFrames), liveStream)
            : replayGap
              ? Stream.concat(Stream.fromIterable([replayGap]), liveStream)
              : liveStream
        const heartbeat = subOptions?.heartbeatInterval ?? defaultHeartbeat
        if (heartbeat === false) {
          return baseStream
        }
        const heartbeatStream = Stream.tick(heartbeat).pipe(Stream.map(() => HeartbeatFrame))
        return Stream.merge(baseStream, heartbeatStream, { haltStrategy: "left" })
      }),
    )

  const defaultSubscription = createSubscription()
  const subscribeFn = (subOptions?: SubscribeOptions) => createSubscription(subOptions)
  const subscribe = Object.assign(subscribeFn, defaultSubscription)
  Object.setPrototypeOf(subscribe, Object.getPrototypeOf(defaultSubscription))

  return Service.of({
    subscribe: subscribe as any,
    stream: createSubscription,
    replaySince: (lastEventID: string) => ringBuffer.replaySince(lastEventID),
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    return yield* make(bus.listen, { heartbeatInterval: DefaultHeartbeatInterval })
  }),
)
