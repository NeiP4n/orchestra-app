import { describe, expect, test } from "bun:test"
import { Agent } from "@orchestra/core/agent"
import { Bus } from "@orchestra/core/bus"
import { Credential } from "@orchestra/schema/credential"
import { Event } from "@orchestra/schema/event"
import { IntegrationID } from "@orchestra/schema/integration-id"
import { Deferred, Duration, Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { it } from "../../core/test/lib/effect"
import { EventFeed } from "../src/event-feed"

const Internal = Bus.ephemeral({ type: "test.internal", schema: { value: Schema.String } })

const event = (id: string): Event.Payload<typeof Agent.Event.Updated> => ({
  id: Event.ID.make(`evt_${id}`),
  created: Date.now(),
  type: Agent.Event.Updated.type,
  data: {},
})

const internal = (value: string): Event.Payload<typeof Internal> => ({
  id: Event.ID.create(),
  created: Date.now(),
  type: Internal.type,
  data: { value },
})

function makeSource() {
  let subscriber: Bus.Subscriber | undefined
  return {
    observe: (next: Bus.Subscriber) =>
      Effect.sync(() => {
        subscriber = next
        return Effect.sync(() => {
          if (subscriber === next) subscriber = undefined
        })
      }),
    publish: (event: Event.Payload) => Effect.suspend(() => (subscriber ? subscriber(event) : Effect.void)),
  }
}

describe("EventFeed", () => {
  test("preserves the public SSE frame encoding", () => {
    const payload = event("wire")
    expect(EventFeed.frame(payload)).toBe(`data: ${JSON.stringify(payload)}\n\n`)
  })

  it.effect("encodes once and delivers the same frame to every subscriber", () =>
    Effect.gen(function* () {
      let encodes = 0
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        encode: (event) => {
          encodes += 1
          return event.type
        },
      })
      const first = yield* feed.subscribe
      const second = yield* feed.subscribe
      const left = yield* first.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const right = yield* second.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)

      yield* source.publish(event("example"))

      expect([Array.from(yield* Fiber.join(left)), Array.from(yield* Fiber.join(right))]).toEqual([
        [Agent.Event.Updated.type],
        [Agent.Event.Updated.type],
      ])
      expect(encodes).toBe(1)
    }),
  )

  it.effect("fails only the subscriber that exceeds its lag capacity", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        capacity: 1,
        encode: (event) => event.id,
      })
      const slow = yield* feed.subscribe
      const fast = yield* feed.subscribe
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const received = new Array<string>()
      const fastFiber = yield* fast.pipe(
        Stream.take(3),
        Stream.runForEach((frame) =>
          Effect.sync(() => received.push(frame)).pipe(
            Effect.andThen(
              frame === "evt_one"
                ? Deferred.succeed(first, undefined)
                : frame === "evt_two"
                  ? Deferred.succeed(second, undefined)
                  : Effect.void,
            ),
          ),
        ),
        Effect.forkScoped,
      )

      yield* source.publish(event("one"))
      yield* Deferred.await(first)
      yield* source.publish(event("two"))
      yield* Deferred.await(second)
      yield* source.publish(event("three"))

      yield* Fiber.join(fastFiber)

      const result = yield* slow.pipe(Stream.runCollect, Effect.exit)
      expect(received).toEqual(["evt_one", "evt_two", "evt_three"])
      expect(Exit.isFailure(result)).toBeTrue()
      if (Exit.isSuccess(result)) return
      expect(Option.getOrUndefined(Exit.findErrorOption(result))).toBeInstanceOf(EventFeed.SubscriberOverflowError)
    }),
  )

  it.effect("delivers global credential events to public subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.type })
      const stream = yield* feed.subscribe
      const received = yield* stream.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)

      yield* source.publish({
        id: Event.ID.create(),
        created: Date.now(),
        type: Credential.Event.Switched.type,
        data: {
          credentialID: Credential.ID.make("cred_test"),
          integrationID: IntegrationID.make("openai"),
        },
      })

      expect(Array.from(yield* Fiber.join(received))).toEqual([Credential.Event.Switched.type])
    }),
  )

  it.effect("filters internal events before they consume subscriber capacity", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { capacity: 1, encode: (event) => event.type })
      const stream = yield* feed.subscribe

      yield* source.publish(internal("one"))
      yield* source.publish(internal("two"))
      yield* source.publish(event("public"))

      expect(Array.from(yield* stream.pipe(Stream.take(1), Stream.runCollect))).toEqual([Agent.Event.Updated.type])
    }),
  )

  it.effect("disconnects current subscribers after an encoding failure and continues for later subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        encode: (event) => {
          if (event.id === Event.ID.make("evt_bad")) throw new Error("invalid event")
          return event.id
        },
      })
      const current = yield* feed.subscribe
      const failed = yield* current.pipe(Stream.runCollect, Effect.exit, Effect.forkScoped)

      yield* source.publish(event("bad"))
      const exit = yield* Fiber.join(failed)

      const next = yield* feed.subscribe
      const received = yield* next.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* source.publish(event("good"))

      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isSuccess(exit)) return
      expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(EventFeed.EncodingError)
      expect(Array.from(yield* Fiber.join(received))).toEqual(["evt_good"])
    }),
  )

  test("formats frame with optional event id", () => {
    const payload = event("wire")
    expect(EventFeed.frame(payload, { id: true })).toBe(`id: ${payload.id}\ndata: ${JSON.stringify(payload)}\n\n`)
  })

  it.live("emits periodic heartbeat frames to keep connection alive", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        heartbeatInterval: Duration.millis(15),
        encode: (e) => e.id,
      })
      const stream = yield* feed.subscribe
      const frames = yield* stream.pipe(Stream.take(2), Stream.runCollect)
      expect(Array.from(frames)).toEqual([EventFeed.HeartbeatFrame, EventFeed.HeartbeatFrame])
    }),
  )

  it.effect("replays missed events upon reconnection using Last-Event-ID", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        replayCapacity: 10,
        encode: (e) => e.id,
      })

      // Client 1 connected and receives event one
      const stream1 = yield* feed.stream()
      const client1Received = yield* stream1.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* source.publish(event("one"))
      expect(Array.from(yield* Fiber.join(client1Received))).toEqual(["evt_one"])

      // Disconnection: events two and three are published while client 1 is disconnected
      yield* source.publish(event("two"))
      yield* source.publish(event("three"))

      // Client 1 reconnects with Last-Event-ID "evt_one", receiving missed events and new event four
      const stream2 = yield* feed.stream({ lastEventID: "evt_one" })
      const client2Received = yield* stream2.pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)

      yield* source.publish(event("four"))
      expect(Array.from(yield* Fiber.join(client2Received))).toEqual(["evt_two", "evt_three", "evt_four"])
    }),
  )

  it.effect("handles evicted events in ring buffer gracefully", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        replayCapacity: 2,
        encode: (e) => e.id,
      })

      yield* source.publish(event("one"))
      yield* source.publish(event("two"))
      yield* source.publish(event("three"))

      // "evt_one" was evicted because capacity is 2 (retaining evt_two, evt_three)
      expect(feed.replaySince("evt_one")).toBeUndefined()
      expect(feed.replaySince("evt_two")).toEqual(["evt_three"])

      // Reconnecting with evicted ID starts fresh with live events
      const stream = yield* feed.stream({ lastEventID: "evt_one" })
      const received = yield* stream.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* source.publish(event("four"))
      expect(Array.from(yield* Fiber.join(received))).toEqual(["evt_four"])
    }),
  )
})
