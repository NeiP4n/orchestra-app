export * as EventFeed from "./event-feed"

import { Bus } from "@orchestra/core/bus"
import { Event } from "@orchestra/schema/event"
import { isOrchestraEvent, type OrchestraEvent } from "@orchestra/protocol/groups/event"
import { Cause, Context, Duration, Effect, Layer, Queue, Schema, Scope, Stream } from "effect"

export const SubscriberCapacity = 4_096
export const DefaultReplayCapacity = 512
export const DefaultHeartbeatInterval = "15 seconds"
export const HeartbeatFrame = ": heartbeat\n\n"

export class SubscriberOverflowError extends Schema.TaggedError<SubscriberOverflowError>()(
  "EventFeed.SubscriberOverflow",
  { capacity: Schema.Int },
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

export class EventRingBuffer {
  private readonly items: Array<{ readonly id: string; readonly encoded: string }> = []

  constructor(readonly capacity: number) {}

  push(item: { readonly id: string; readonly encoded: string }) {
    if (this.capacity <= 0) return
    if (this.items.length >= this.capacity) {
      this.items.shift()
    }
    this.items.push(item)
  }

  replaySince(lastEventID: string): ReadonlyArray<string> | undefined {
    const index = this.items.findIndex((item) => item.id === lastEventID)
    if (index === -1) return undefined
    return this.items.slice(index + 1).map((item) => item.encoded)
  }

  get size(): number {
    return this.items.length
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
    readonly replayCapacity?: number
    readonly heartbeatInterval?: Duration.Input | false
    readonly encode?: (event: OrchestraEvent) => string
  },
) {
  const capacity = options?.capacity ?? SubscriberCapacity
  const replayCapacity = options?.replayCapacity ?? DefaultReplayCapacity
  const defaultHeartbeat = options?.heartbeatInterval ?? false
  const render = options?.encode ?? frame
  const ringBuffer = new EventRingBuffer(replayCapacity)
  const subscribers = new Set<Queue.Queue<string, Error>>()

  const fail = (error: Error) =>
    Effect.sync(() => {
      const current = Array.from(subscribers)
      subscribers.clear()
      for (const subscriber of current) Queue.failCauseUnsafe(subscriber, Cause.fail(error))
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
    for (const subscriber of subscribers) {
      if (Queue.offerUnsafe(subscriber, encoded)) continue
      subscribers.delete(subscriber)
      Queue.failCauseUnsafe(subscriber, Cause.fail(new SubscriberOverflowError({ capacity })))
    }
  })

  const unsubscribe = yield* observe(publish)
  yield* Effect.addFinalizer(() => unsubscribe)

  const createSubscription = (subOptions?: SubscribeOptions) =>
    Effect.acquireRelease(
      Queue.dropping<string, Error>(capacity).pipe(
        Effect.tap((queue) => Effect.sync(() => subscribers.add(queue))),
      ),
      (queue) =>
        Effect.sync(() => subscribers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid),
    ).pipe(
      Effect.map((queue) => {
        const liveStream = Stream.fromQueue(queue)
        const replayFrames = subOptions?.lastEventID ? ringBuffer.replaySince(subOptions.lastEventID) : undefined
        const baseStream =
          replayFrames && replayFrames.length > 0
            ? Stream.concat(Stream.fromIterable(replayFrames), liveStream)
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
