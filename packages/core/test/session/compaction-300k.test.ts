import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, LanguageModel, ToolDefinition, type LLMRequest } from "@orchestra/ai"
import { OpenAIChat } from "@orchestra/ai/protocols"
import { Database } from "@orchestra/core/database/database"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { llmClient } from "@orchestra/core/effect/app-node-platform"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Bus } from "@orchestra/core/bus"
import { SessionCompaction } from "@orchestra/core/session/compaction"
import type { SessionContext } from "@orchestra/core/session/context"
import { SessionEvent } from "@orchestra/core/session/event"
import { SessionMessage } from "@orchestra/core/session/message"
import { SessionModelRequest } from "@orchestra/core/session/model-request"
import { PluginHooks } from "@orchestra/core/plugin/hooks"
import { SessionProjector } from "@orchestra/core/session/projector"
import { SessionRunnerModel } from "@orchestra/core/session/runner/model"
import { InstructionStateTable, SessionTable } from "@orchestra/core/session/sql"
import { SessionStore } from "@orchestra/core/session/store"
import { Session } from "@orchestra/core/session"
import { Location } from "@orchestra/core/location"
import { Project } from "@orchestra/core/project"
import { ProjectTable } from "@orchestra/core/project/sql"
import { Agent } from "@orchestra/core/agent"
import { AbsolutePath } from "@orchestra/core/schema"
import { Instruction } from "@orchestra/schema/instruction"
import { Money } from "@orchestra/schema/money"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "../lib/effect"

let capturedRequests: LLMRequest[] = []
let onStreamHook: (() => Effect.Effect<void>) | undefined

const model = LanguageModel.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route,
})

const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]

const mockLLM = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    capturedRequests.push(request)
    const baseStream = Stream.make(
      LLMEvent.textDelta({
        id: "summary-delta",
        text: "## Objective\n- 300k context compaction test\n## Requirements\n- verify\n## Decisions\n- none\n## Work State\n### Completed\n- test\n### Active\n- test\n### Blocked\n- none\n## Next Move\n- finish\n## Relevant Files\n- compaction-300k.test.ts\n## Important Context\n- 300k+ tokens context",
      }),
      LLMEvent.stepFinish({
        index: 0,
        reason: { normalized: "stop" },
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          nonCachedInputTokens: 80,
          cacheReadInputTokens: 10,
          cacheWriteInputTokens: 10,
          reasoningTokens: 0,
        },
      }),
      LLMEvent.finish({
        reason: { normalized: "stop" },
      }),
    )
    if (onStreamHook) {
      return Stream.fromEffect(onStreamHook()).pipe(Stream.flatMap(() => baseStream))
    }
    return baseStream
  },
  generate: () => Effect.die("unused"),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(mockLLM),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

const insertTestSession = (id: Session.ID, overrides?: Partial<typeof SessionTable.$inferInsert>) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        ...overrides,
      })
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    return yield* store
      .get(id)
      .pipe(Effect.flatMap((s) => (s ? Effect.succeed(s) : Effect.die(`session missing: ${id}`))))
  })

describe("Compaction 300k Context Verification (TEST-300K-001)", () => {
  it.effect("1. Verifies context estimation accurately reaches > 300,000 tokens", () =>
    Effect.gen(function* () {
      const session = yield* insertTestSession(Session.ID.make("ses_estimate_320k"))

      // Context window is 1M tokens with 800k input limit
      const bigModel = SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost,
        limit: { context: 1_000_000, input: 800_000, output: 64_000 },
      })

      const context320k: SessionContext.Loaded = {
        session,
        model: bigModel,
        messages: [
          Schema.decodeUnknownSync(SessionMessage.Assistant)({
            id: SessionMessage.ID.make("msg_anchor_320k"),
            type: "assistant",
            agent: Agent.defaultID,
            model: { id: "summary-model", providerID: "test" },
            content: [{ type: "text", text: "Processing massive prompt." }],
            tokens: { input: 325_000, output: 250, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, completed: 0 },
          }),
        ],
        agent: {
          id: Agent.defaultID,
          info: { ...Agent.Info.default(Agent.defaultID), system: "System instructions." },
        },
        initial: "Project initial prompt.",
        tools: {
          definitions: [
            ToolDefinition.make({ name: "read", description: "Read files", inputSchema: { type: "object" } }),
          ],
          execute: () => Effect.die("unused"),
        },
      }

      const estimated = SessionCompaction.estimateContext(context320k)
      expect(estimated).toBeGreaterThan(300_000)
      expect(estimated).toBe(325_250)
    }),
  )

  it.effect("2. Scenario A (No Limit / threshold 0): auto-compaction is strictly skipped at 300k+ tokens", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service

      // Test with numeric 0 and textual "без лимита"
      const thresholdValues = [0, "0", "без лимита", "Без лимита", "unlimited", "off"]

      for (const thresholdVal of thresholdValues) {
        const session = yield* insertTestSession(
          Session.ID.make(`ses_nolimit_${Math.random().toString(36).slice(2, 7)}`),
          { metadata: { compaction_threshold: thresholdVal } },
        )

        const bigModel = SessionRunnerModel.resolved(model, {
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          cost,
          limit: { context: 1_000_000, input: 800_000, output: 64_000 },
        })

        const context300k: SessionContext.Loaded = {
          session,
          model: bigModel,
          messages: [
            Schema.decodeUnknownSync(SessionMessage.Assistant)({
              id: SessionMessage.ID.make(`msg_ast_${Math.random().toString(36).slice(2, 7)}`),
              type: "assistant",
              agent: Agent.defaultID,
              model: { id: "summary-model", providerID: "test" },
              content: [{ type: "text", text: "Heavy session turn." }],
              tokens: { input: 350_000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 0, completed: 0 },
            }),
          ],
          agent: {
            id: Agent.defaultID,
            info: { ...Agent.Info.default(Agent.defaultID), system: "System" },
          },
          initial: "Initial",
          tools: { definitions: [], execute: () => Effect.die("unused") },
        }

        // Verify context is indeed over 300k tokens
        expect(SessionCompaction.estimateContext(context300k)).toBe(350_500)

        // Run auto-compaction
        const outcome = yield* compaction.compact({ reason: "auto", context: context300k })

        // Result MUST be strictly { status: "skipped" }
        expect(outcome.status).toBe("skipped")
      }
    }),
  )

  it.effect("3. Scenario B (Explicit 200k threshold): auto-compaction triggers at 300k+ tokens", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      capturedRequests = []

      // Threshold explicitly configured to 200,000 tokens
      const session = yield* insertTestSession(Session.ID.make("ses_threshold_200k"), {
        metadata: { compaction_threshold: 200_000 },
      })

      const bigModel = SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost,
        limit: { context: 1_000_000, input: 800_000, output: 64_000 },
      })

      const context300k: SessionContext.Loaded = {
        session,
        model: bigModel,
        messages: [
          Schema.decodeUnknownSync(SessionMessage.User)({
            id: SessionMessage.ID.make("msg_user_1"),
            type: "user",
            text: "Please process our large conversation.",
            time: { created: 0 },
          }),
          Schema.decodeUnknownSync(SessionMessage.Assistant)({
            id: SessionMessage.ID.make("msg_anchor_310k"),
            type: "assistant",
            agent: Agent.defaultID,
            model: { id: "summary-model", providerID: "test" },
            content: [{ type: "text", text: "Here is the response." }],
            tokens: { input: 310_000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, completed: 2 },
          }),
        ],
        agent: {
          id: Agent.defaultID,
          info: { ...Agent.Info.default(Agent.defaultID), system: "System" },
        },
        initial: "Initial",
        tools: { definitions: [], execute: () => Effect.die("unused") },
      }

      expect(SessionCompaction.estimateContext(context300k)).toBeGreaterThan(300_000)

      // Run auto-compaction
      const outcome = yield* compaction.compact({ reason: "auto", context: context300k })

      // With threshold 200k and context 310k, compaction MUST execute and NOT be skipped!
      expect(outcome.status).not.toBe("skipped")
      expect(outcome.status).toBe("completed")
      expect(capturedRequests.length).toBeGreaterThan(0)
    }),
  )

  it.effect("4. Scenario C (Configuration default 0): auto-compaction is disabled globally", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service

      // Configure global service setting threshold to 0
      yield* compaction.transform((editor) => editor.configure({ threshold: 0 }))

      // Session without any metadata threshold override
      const session = yield* insertTestSession(Session.ID.make("ses_global_zero_threshold"), {
        metadata: {},
      })

      const bigModel = SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost,
        limit: { context: 1_000_000, input: 800_000, output: 64_000 },
      })

      const context340k: SessionContext.Loaded = {
        session,
        model: bigModel,
        messages: [
          Schema.decodeUnknownSync(SessionMessage.Assistant)({
            id: SessionMessage.ID.make("msg_anchor_340k"),
            type: "assistant",
            agent: Agent.defaultID,
            model: { id: "summary-model", providerID: "test" },
            content: [{ type: "text", text: "Session content." }],
            tokens: { input: 340_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, completed: 0 },
          }),
        ],
        agent: {
          id: Agent.defaultID,
          info: { ...Agent.Info.default(Agent.defaultID), system: "System" },
        },
        initial: "Initial",
        tools: { definitions: [], execute: () => Effect.die("unused") },
      }

      expect(SessionCompaction.estimateContext(context340k)).toBe(340_100)

      const outcome = yield* compaction.compact({ reason: "auto", context: context340k })
      expect(outcome.status).toBe("skipped")
    }),
  )

  it.effect("5. Real text payload: unmeasured textual stream exceeding 300k tokens does not compact in No-Limit mode", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service

      const session = yield* insertTestSession(Session.ID.make("ses_real_text_payload"), {
        metadata: { compaction_threshold: "без лимита" },
      })

      const bigModel = SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost,
        limit: { context: 1_000_000, input: 800_000, output: 64_000 },
      })

      // Generate a massive text chunk: ~1,250,000 characters (~312,500 tokens at 4 chars/token)
      const hugeText = "LargeContextPayload ".repeat(65_000)

      const contextRealText: SessionContext.Loaded = {
        session,
        model: bigModel,
        messages: [
          Schema.decodeUnknownSync(SessionMessage.User)({
            id: SessionMessage.ID.make("msg_huge_user"),
            type: "user",
            text: hugeText,
            time: { created: 0 },
          }),
        ],
        agent: {
          id: Agent.defaultID,
          info: { ...Agent.Info.default(Agent.defaultID), system: "System" },
        },
        initial: "Initial instructions",
        tools: { definitions: [], execute: () => Effect.die("unused") },
      }

      const estimated = SessionCompaction.estimateContext(contextRealText)
      expect(estimated).toBeGreaterThan(300_000)

      const outcome = yield* compaction.compact({ reason: "auto", context: contextRealText })
      expect(outcome.status).toBe("skipped")
    }),
  )

  it.effect(
    "6. Concurrent instruction updates during compaction: updated instructions are preserved across compaction boundaries",
    () =>
      Effect.gen(function* () {
        const compaction = yield* SessionCompaction.Service
        const bus = yield* Bus.Service
        const db = (yield* Database.Service).db

        const session = yield* insertTestSession(Session.ID.make("ses_concurrent_instructions"), {
          metadata: { compaction_threshold: 200_000 },
        })

        const hashDevV1 = Schema.decodeUnknownSync(Instruction.Hash)("1".repeat(64))
        const hashRulesV1 = Schema.decodeUnknownSync(Instruction.Hash)("2".repeat(64))
        const hashDevV2 = Schema.decodeUnknownSync(Instruction.Hash)("3".repeat(64))
        const hashToolV1 = Schema.decodeUnknownSync(Instruction.Hash)("4".repeat(64))

        const initialValues: Instruction.Values = {
          "system/role": hashDevV1,
          "system/base_rules": hashRulesV1,
        }

        yield* db
          .insert(InstructionStateTable)
          .values({
            session_id: session.id,
            epoch_start: 1,
            through_seq: 1,
            initial_values: initialValues,
            current_values: initialValues,
          })
          .run()
          .pipe(Effect.orDie)

        const bigModel = SessionRunnerModel.resolved(model, {
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          cost,
          limit: { context: 1_000_000, input: 800_000, output: 64_000 },
        })

        const context350k: SessionContext.Loaded = {
          session,
          model: bigModel,
          messages: [
            Schema.decodeUnknownSync(SessionMessage.User)({
              id: SessionMessage.ID.make("msg_concurrent_user"),
              type: "user",
              text: "Explain the architecture in detail",
              time: { created: 0 },
            }),
            Schema.decodeUnknownSync(SessionMessage.Assistant)({
              id: SessionMessage.ID.make("msg_concurrent_assistant"),
              type: "assistant",
              agent: Agent.defaultID,
              model: { id: "summary-model", providerID: "test" },
              content: [{ type: "text", text: "Summary of large architecture discussion" }],
              tokens: { input: 350_000, output: 2_000, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, completed: 2 },
            }),
          ],
          agent: {
            id: Agent.defaultID,
            info: { ...Agent.Info.default(Agent.defaultID), system: "System" },
          },
          initial: "Initial instructions",
          tools: { definitions: [], execute: () => Effect.die("unused") },
        }

        // Simulate concurrent instruction update during LLM summary generation
        onStreamHook = () =>
          Effect.gen(function* () {
            yield* bus.publish(SessionEvent.InstructionsUpdated, {
              sessionID: session.id,
              delta: {
                "system/role": hashDevV2,
                "system/new_tool": hashToolV1,
              },
              text: "Updated system role to v2 and added new_tool",
            })
          })

        const outcome = yield* compaction.compact({ reason: "auto", context: context350k })
        onStreamHook = undefined

        expect(outcome.status).toBe("completed")

        const finalState = yield* db
          .select()
          .from(InstructionStateTable)
          .where(eq(InstructionStateTable.session_id, session.id))
          .get()
          .pipe(Effect.orDie)

        expect(finalState).toBeDefined()
        const currentValues = finalState?.current_values as Record<string, string>
        const initialSavedValues = finalState?.initial_values as Record<string, string>

        // Verify updated role was preserved and not overwritten by stale v1
        expect(currentValues["system/role"]).toBe(hashDevV2)
        expect(currentValues["system/base_rules"]).toBe(hashRulesV1)
        expect(currentValues["system/new_tool"]).toBe(hashToolV1)

        expect(initialSavedValues["system/role"]).toBe(hashDevV2)
        expect(initialSavedValues["system/base_rules"]).toBe(hashRulesV1)
        expect(initialSavedValues["system/new_tool"]).toBe(hashToolV1)
      }),
  )
})
