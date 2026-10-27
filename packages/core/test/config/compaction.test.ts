import { describe, expect } from "bun:test"
import { LanguageModel, LLMClient, LLMEvent } from "@orchestra/ai"
import { OpenAIChat } from "@orchestra/ai/protocols"
import { Bus } from "@orchestra/core/bus"
import { Config } from "@orchestra/core/config"
import { ConfigCompactionPlugin } from "@orchestra/core/config/plugin/compaction"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { llmClient } from "@orchestra/core/effect/app-node-platform"
import { SessionCompaction } from "@orchestra/core/session/compaction"
import { SessionEvent } from "@orchestra/core/session/event"
import { SessionMessage } from "@orchestra/core/session/message"
import { SessionModelRequest } from "@orchestra/core/session/model-request"
import { SessionRunnerModel } from "@orchestra/core/session/runner/model"
import { Session } from "@orchestra/core/session"
import { Agent } from "@orchestra/core/agent"
import { Location } from "@orchestra/core/location"
import { Project } from "@orchestra/core/project"
import { AbsolutePath } from "@orchestra/core/schema"
import { ConfigCompaction } from "@orchestra/schema/config/compaction"
import { Document, Event, Info } from "@orchestra/schema/config"
import { Money } from "@orchestra/schema/money"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { DateTime, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const model = LanguageModel.make({
  id: "test-model",
  provider: "test-provider",
  route: OpenAIChat.route,
})
const limit = { context: 100_000, output: 1_000 }
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit,
})
const config = Config.testLayer()
const it = testEffect(
  Layer.merge(
    config,
    AppNodeBuilder.build(LayerNode.group([SessionCompaction.node, SessionModelRequest.node, Config.node, Bus.node]), [
      llmClient.replace(
        Layer.mock(LLMClient.Service)({
          stream: () => Stream.make(LLMEvent.textDelta({ id: "summary", text: "## Objective\n- summary" })),
        }),
      ),
      Config.node.replace(config),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/tmp") })),
    ]),
  ),
)
describe("ConfigCompactionPlugin.Plugin", () => {
  it.live("merges settings and reloads changed config", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      // An automatic compaction that is not due is skipped.
      const due = (input: typeof nearInput) =>
        compaction
          .compact({ reason: "auto", context: input.context })
          .pipe(Effect.map((outcome) => outcome.status !== "skipped"))
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: false, buffer: 20_000 }) }),
        }),
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({
              buffer: 10_000,
              keep: new ConfigCompaction.Keep({ tokens: 0 }),
            }),
          }),
        }),
      ])
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))

      expect(yield* due(nearInput)).toBe(false)
      const ended = yield* bus
        .subscribe(SessionEvent.Compaction.Ended)
        .pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
      const messages = [
        SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text: "Older context",
          time: { created: DateTime.makeUnsafe(0) },
        }),
        SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text: "Recent context",
          time: { created: DateTime.makeUnsafe(1) },
        }),
      ]
      expect(
        yield* compaction.compact({
          reason: "manual",
          context: { ...nearInput.context, messages },
          inputID: SessionMessage.ID.make("msg_compaction_manual"),
        }),
      ).toEqual({ status: "completed" })
      expect(Option.getOrThrow(yield* Fiber.join(ended)).data.recent).toContain("Recent context")

      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: true, buffer: 20_000 }) }),
        }),
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ buffer: 10_000 }) }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (yield* due(nearInput)) return
          yield* Effect.sleep("10 millis")
        }
        yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
      })
      expect(yield* due(bufferedInput)).toBe(false)

      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: true, buffer: 20_000 }) }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      for (let attempt = 0; attempt < 200; attempt++) {
        if (yield* due(bufferedInput)) return
        yield* Effect.sleep("10 millis")
      }
      yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
    }),
  )

  it.live("compacts at the configured share of the window and keeps its free share", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      const due = (input: typeof nearInput) =>
        compaction
          .compact({ reason: "auto", context: input.context })
          .pipe(Effect.map((outcome) => outcome.status !== "skipped"))
      // 90% of the 100k window is the trigger; only 5% stays free after the compact.
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({ auto: true, threshold_percent: 90, keep_free_percent: 5 }),
          }),
        }),
      ])
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))

      expect(yield* due(bufferedInput)).toBe(false)
      expect(yield* due(nearInput)).toBe(true)

      // Lowering the threshold to 80% makes a compacted-at-85k context due on the next reload.
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({ auto: true, threshold_percent: 80, keep_free_percent: 5 }),
          }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      for (let attempt = 0; attempt < 200; attempt++) {
        if (yield* due(bufferedInput)) return
        yield* Effect.sleep("10 millis")
      }
      yield* Effect.die(new Error("Timed out waiting for the percent threshold to reload"))
    }),
  )

  it.live("applies config.compaction.threshold as the default threshold for all new chats", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      const due = (input: typeof nearInput) =>
        compaction
          .compact({ reason: "auto", context: input.context })
          .pipe(Effect.map((outcome) => outcome.status !== "skipped"))

      // Set config.compaction.threshold to 80_000 tokens
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({ auto: true, threshold: 80_000 }),
          }),
        }),
      ])
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))

      // Verify settings threshold updated
      expect(compaction.getSettings().threshold).toBe(80_000)

      // 85k tokens exceeds the 80k default threshold -> due for auto-compaction
      expect(yield* due(bufferedInput)).toBe(true)

      // Test session metadata custom override: a session with threshold 100k does not trigger at 85k
      const sessionWithHigherThreshold = {
        ...bufferedInput.context,
        session: Session.Info.make({
          ...session,
          id: Session.ID.make("ses_custom_thresh"),
          metadata: { compaction_threshold: 100_000 },
        }),
      }
      expect(
        yield* compaction
          .compact({ reason: "auto", context: sessionWithHigherThreshold })
          .pipe(Effect.map((outcome) => outcome.status !== "skipped")),
      ).toBe(false)

      // A session with string threshold "70k" triggers auto compaction at 85k
      const sessionWithLowerStringThreshold = {
        ...bufferedInput.context,
        session: Session.Info.make({
          ...session,
          id: Session.ID.make("ses_custom_thresh_str"),
          metadata: { compaction_threshold: "70k" },
        }),
      }
      expect(
        yield* compaction
          .compact({ reason: "auto", context: sessionWithLowerStringThreshold })
          .pipe(Effect.map((outcome) => outcome.status !== "skipped")),
      ).toBe(true)

      // A session with threshold 0 ("без лимита") disables auto-compaction completely: returns skipped
      const sessionWithZeroThreshold = {
        ...bufferedInput.context,
        session: Session.Info.make({
          ...session,
          id: Session.ID.make("ses_custom_thresh_zero"),
          metadata: { compaction_threshold: 0 },
        }),
      }
      expect(
        yield* compaction
          .compact({ reason: "auto", context: sessionWithZeroThreshold })
          .pipe(Effect.map((outcome) => outcome.status !== "skipped")),
      ).toBe(false)

      const sessionWithNoLimitStringThreshold = {
        ...bufferedInput.context,
        session: Session.Info.make({
          ...session,
          id: Session.ID.make("ses_custom_thresh_nolimit"),
          metadata: { compaction_threshold: "без лимита" },
        }),
      }
      expect(
        yield* compaction
          .compact({ reason: "auto", context: sessionWithNoLimitStringThreshold })
          .pipe(Effect.map((outcome) => outcome.status !== "skipped")),
      ).toBe(false)
    }),
  )

  it.live("provides parseCompactionThreshold and formatCompactionThreshold utilities", () =>
    Effect.sync(() => {
      expect(SessionCompaction.parseCompactionThreshold("400k")).toBe(400_000)
      expect(SessionCompaction.parseCompactionThreshold("1.5m")).toBe(1_500_000)
      expect(SessionCompaction.parseCompactionThreshold("200000")).toBe(200_000)
      expect(SessionCompaction.parseCompactionThreshold(0)).toBe(0)
      expect(SessionCompaction.parseCompactionThreshold("Без сжатия")).toBe(0)
      expect(SessionCompaction.parseCompactionThreshold("Full window")).toBe(0)

      expect(SessionCompaction.formatCompactionThreshold(400_000)).toBe("400k")
      expect(SessionCompaction.formatCompactionThreshold(1_500_000)).toBe("1.5m")
      expect(SessionCompaction.formatCompactionThreshold(0)).toBe("Без сжатия")
      expect(SessionCompaction.formatCompactionThreshold(0, "Full window")).toBe("Full window")
    }),
  )
})

const session = Session.Info.make({
  id: Session.ID.make("ses_compaction_config"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
})
const input = (tokens: number) => {
  const messages = [
    Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.make("msg_compaction_config"),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "test-model", providerID: "test-provider" },
      content: [],
      tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, completed: 0 },
    }),
  ]
  return {
    session,
    resolved,
    messages,
    context: {
      session,
      model: resolved,
      messages,
      agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
      initial: "",
      tools: { definitions: [], execute: () => Effect.die("unused") },
    },
  }
}
const bufferedInput = input(85_000)
const nearInput = input(95_000)
