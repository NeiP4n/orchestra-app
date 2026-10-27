import { describe, expect } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Bus } from "@orchestra/core/bus"
import { Database } from "@orchestra/core/database/database"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { SessionEvent } from "@orchestra/schema/session-event"
import { SessionID } from "@orchestra/schema/session-id"
import { SessionMessage } from "@orchestra/schema/session-message"
import { Agent } from "@orchestra/schema/agent"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node])))

describe("EventBus performance and stream filtering", () => {
  it.effect("dispatches intensive text deltas without waking unrelated multi-type subscribers", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const sessionID = SessionID.make("ses_perf_test")
      const messageID = SessionMessage.ID.make("msg_perf_test")

      let unrelatedReceived = 0
      const unrelatedSubscription = yield* bus
        .subscribe([SessionEvent.Created, Agent.Event.Updated])
        .pipe(
          Stream.tap(() => Effect.sync(() => unrelatedReceived++)),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        )

      const deltasReceived: string[] = []
      const deltaSubscription = yield* bus
        .subscribe(SessionEvent.Text.Delta)
        .pipe(
          Stream.take(100),
          Stream.tap((event) => Effect.sync(() => deltasReceived.push(event.data.delta))),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        )

      yield* Effect.yieldNow

      for (let i = 0; i < 100; i++) {
        yield* bus.publish(SessionEvent.Text.Delta, {
          sessionID,
          assistantMessageID: messageID,
          ordinal: i,
          delta: `tok_${i}`,
        })
      }

      yield* Fiber.join(deltaSubscription)
      yield* Fiber.interrupt(unrelatedSubscription)
      expect(deltasReceived.length).toBe(100)
      expect(unrelatedReceived).toBe(0)
    }),
  )

  it.effect("typed listeners bypass execution for irrelevant event types", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      let agentUpdatedCalls = 0

      const unsubscribe = yield* bus.listen(
        () =>
          Effect.sync(() => {
            agentUpdatedCalls++
          }),
        { types: ["agent.updated"] },
      )

      const sessionID = SessionID.make("ses_typed_test")
      const messageID = SessionMessage.ID.make("msg_typed_test")

      for (let i = 0; i < 50; i++) {
        yield* bus.publish(SessionEvent.Text.Delta, {
          sessionID,
          assistantMessageID: messageID,
          ordinal: i,
          delta: "chunk",
        })
      }

      expect(agentUpdatedCalls).toBe(0)

      yield* bus.publish(Agent.Event.Updated, {})
      expect(agentUpdatedCalls).toBe(1)

      yield* unsubscribe
      yield* bus.publish(Agent.Event.Updated, {})
      expect(agentUpdatedCalls).toBe(1)
    }),
  )
})
