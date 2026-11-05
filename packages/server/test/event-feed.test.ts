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

describe("EventRingBuffer", () => {
  const frame = (id: string) => ({ id, encoded: `data: ${id}\n\n` })

  test("keeps the newest frames in publish order after wrapping", () => {
    const ring = new EventFeed.EventRingBuffer(3)
    for (const id of ["evt_one", "evt_two", "evt_three", "evt_four", "evt_five"]) ring.push(frame(id))

    expect(ring.size).toBe(3)
    expect(ring.replaySince("evt_two")).toBeUndefined()
    expect(ring.replaySince("evt_three")).toEqual(["data: evt_four\n\n", "data: evt_five\n\n"])
    expect(ring.replaySince("evt_five")).toEqual([])
  })

  test("never retains more than its capacity", () => {
    const ring = new EventFeed.EventRingBuffer(2)
    for (let index = 0; index < 1_000; index++) ring.push(frame(`evt_${index}`))

    expect(ring.size).toBe(2)
    expect(ring.replaySince("evt_998")).toEqual(["data: evt_999\n\n"])
  })

  test("ignores pushes when it retains nothing", () => {
    for (const capacity of [0, -1]) {
      const ring = new EventFeed.EventRingBuffer(capacity)
      ring.push(frame("evt_one"))
      expect(ring.size).toBe(0)
      expect(ring.replaySince("evt_one")).toBeUndefined()
    }
  })
})

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

  it.effect("closes a subscriber whose buffered frames exceed the byte budget", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        capacityBytes: 32,
        encode: () => "x".repeat(24),
      })
      const stream = yield* feed.subscribe

      yield* source.publish(event("one"))
      yield* source.publish(event("two"))

      const result = yield* stream.pipe(Stream.runCollect, Effect.exit)
      expect(Option.getOrUndefined(Exit.findErrorOption(result))).toBeInstanceOf(EventFeed.SubscriberOverflowError)
    }),
  )

  it.effect("frees the byte budget as frames are consumed", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        capacityBytes: 64,
        encode: (value) => value.type.padEnd(40, "x"),
      })
      const stream = yield* feed.subscribe

      // Two 40-byte frames do not fit in 64 bytes at once, so the second publish only succeeds
      // because the first frame was consumed and its bytes were returned to the budget.
      yield* source.publish(event("one"))
      expect(yield* stream.pipe(Stream.take(1), Stream.runCollect)).toHaveLength(1)

      yield* source.publish(event("two"))
      expect(yield* stream.pipe(Stream.take(1), Stream.runCollect)).toHaveLength(1)

      yield* source.publish(event("three"))
      yield* source.publish(event("four"))
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

      // Reconnecting with an evicted ID gets a replay-gap frame first, then live events:
      // the client resyncs from the API instead of silently missing evt_two/evt_three.
      const stream = yield* feed.stream({ lastEventID: "evt_one" })
      const received = yield* stream.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* source.publish(event("four"))
      const frames = Array.from(yield* Fiber.join(received))
      expect(frames[0]).toContain("server.replay-gap")
      expect(frames[0]).toContain("evt_one")
      expect(frames[1]).toBe("evt_four")
    }),
  )

  it.effect("replays a 30-second drop inside the widened default window", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { encode: (e) => e.id })
      expect(EventFeed.DefaultReplayCapacity).toBe(4096)

      // 600 streamed events: far past the old 512-frame window.
      yield* Effect.forEach(
        Array.from({ length: 600 }, (_, index) => `drop-${index}`),
        (id) => source.publish(event(id)),
        { discard: true },
      )

      const stream = yield* feed.stream({ lastEventID: "evt_drop-0" })
      const received = yield* stream.pipe(Stream.take(599), Stream.runCollect)
      expect(Array.from(received)).toEqual(
        Array.from({ length: 599 }, (_, index) => `evt_drop-${index + 1}`),
      )
    }),
  )

  test("classifies critical lifecycle events correctly", () => {
    expect(EventFeed.isCriticalEvent({ type: "session.status" })).toBeTrue()
    expect(EventFeed.isCriticalEvent({ type: "session.step.ended" })).toBeTrue()
    expect(EventFeed.isCriticalEvent({ type: "session.step.failed" })).toBeTrue()
    expect(EventFeed.isCriticalEvent({ type: "session.execution.failed" })).toBeTrue()
    expect(EventFeed.isCriticalEvent({ type: "session.interrupted" })).toBeTrue()
    expect(EventFeed.isCriticalEvent({ type: "permission.asked" })).toBeTrue()
    expect(EventFeed.isCriticalEvent({ type: "agent.updated" })).toBeFalse()
    expect(EventFeed.isCriticalEvent({ type: "model.updated" })).toBeFalse()
    expect(EventFeed.isCriticalEvent({ type: "session.text.delta" })).toBeFalse()
  })

  it.effect("reliably delivers critical lifecycle events to subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        capacity: 4,
        encode: (e) => `${e.id}:${e.type}`,
      })
      const stream = yield* feed.subscribe
      const received = yield* stream.pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)

      yield* source.publish({
        id: Event.ID.make("evt_status"),
        created: Date.now(),
        type: "session.status",
        data: {},
      })
      yield* source.publish({
        id: Event.ID.make("evt_step_ended"),
        created: Date.now(),
        type: "session.step.ended",
        data: {},
      })
      yield* source.publish({
        id: Event.ID.make("evt_error"),
        created: Date.now(),
        type: "session.execution.failed",
        data: {},
      })

      const frames = yield* Fiber.join(received)
      expect(Array.from(frames)).toEqual([
        "evt_status:session.status",
        "evt_step_ended:session.step.ended",
        "evt_error:session.execution.failed",
      ])
    }),
  )
})
