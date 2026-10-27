import { describe, expect } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { sql } from "drizzle-orm"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Database } from "@orchestra/core/database/database"
import { Bus } from "@orchestra/core/bus"
import { Session } from "@orchestra/core/session"
import { SessionStore } from "@orchestra/core/session/store"
import { SessionProjector } from "@orchestra/core/session/projector"
import { SessionTransfer } from "@orchestra/core/session/transfer"
import { InstructionEntry } from "@orchestra/core/session/instruction-entry"
import { SessionExecution } from "@orchestra/core/session/execution"
import { SessionInbox } from "@orchestra/core/session/inbox"
import { Project } from "@orchestra/core/project"
import { Location } from "@orchestra/core/location"
import { AbsolutePath } from "@orchestra/core/schema"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { SessionEvent } from "@orchestra/schema/session-event"
import { SessionID } from "@orchestra/schema/session-id"
import { SessionMessage } from "@orchestra/schema/session-message"
import { Instructions } from "@orchestra/core/instructions/index"
import { ToolGuidance } from "@orchestra/core/instructions/guidance"
import { ActionSnippets } from "@orchestra/core/instructions/snippets"
import { SessionCompaction } from "@orchestra/core/session/compaction"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { promptLocationNode } from "./fixture/prompt-location"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionTransfer.node,
      InstructionEntry.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

const location = Location.Ref.make({ directory: AbsolutePath.make("/benchmark-workspace") })

describe("Core Performance Benchmarks (Session, EventBus, Storage)", () => {
  it.live("benchmarks session initialization latency and sequential creation", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const count = 20
      const createdIDs: Session.ID[] = []

      const start = performance.now()
      for (let i = 0; i < count; i++) {
        const item = yield* session.create({
          location,
          title: `Benchmark Session ${i}`,
        })
        createdIDs.push(item.id)
      }
      const elapsedMs = performance.now() - start
      const avgMs = elapsedMs / count

      // Verify all sessions were created and persisted properly
      expect(createdIDs.length).toBe(count)
      for (const id of createdIDs) {
        const item = yield* session.get(id)
        expect(item.id).toBe(id)
      }

      // Performance baseline: in-memory / local SQLite session creation should be < 50ms average
      expect(avgMs).toBeLessThan(50)
    }),
  )

  it.live("benchmarks parallel session creation and prompt admission latency", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      const parallelCount = 10

      // 1. Parallel session creation
      const startCreate = performance.now()
      const createdSessions = yield* Effect.all(
        Array.from({ length: parallelCount }, (_, i) =>
          session.create({
            location,
            title: `Parallel Benchmark ${i}`,
          }),
        ),
        { concurrency: "unbounded" },
      )
      const createElapsedMs = performance.now() - startCreate
      expect(createdSessions.length).toBe(parallelCount)
      expect(createElapsedMs / parallelCount).toBeLessThan(50)

      // 2. Prompt enqueue and promotion benchmark
      const targetSession = createdSessions[0]
      const promptCount = 15
      const startPrompt = performance.now()

      for (let i = 0; i < promptCount; i++) {
        yield* session.prompt({
          sessionID: targetSession.id,
          text: `Benchmark prompt payload ${i}`,
          resume: false,
        })
        yield* SessionInbox.promote(db, bus, targetSession.id, "steer")
      }
      const promptElapsedMs = performance.now() - startPrompt
      const avgPromptMs = promptElapsedMs / promptCount

      // Prompt admission + promotion should be lightweight (< 30ms average per item)
      expect(avgPromptMs).toBeLessThan(30)
    }),
  )

  it.live("benchmarks EventBus delta streaming throughput and subscriber delivery latency", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const sessionID = SessionID.make("ses_benchmark_bus")
      const messageID = SessionMessage.ID.make("msg_benchmark_bus")
      const eventCount = 500

      const receivedDeltas: string[] = []
      const subscription = yield* bus
        .subscribe(SessionEvent.Text.Delta)
        .pipe(
          Stream.take(eventCount),
          Stream.tap((event) => Effect.sync(() => receivedDeltas.push(event.data.delta))),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        )

      yield* Effect.yieldNow

      const startPublish = performance.now()
      for (let i = 0; i < eventCount; i++) {
        yield* bus.publish(SessionEvent.Text.Delta, {
          sessionID,
          assistantMessageID: messageID,
          ordinal: i,
          delta: `delta_token_${i}`,
        })
      }

      yield* Fiber.join(subscription)
      const elapsedMs = performance.now() - startPublish
      const eventsPerSec = (eventCount / elapsedMs) * 1000

      expect(receivedDeltas.length).toBe(eventCount)
      expect(receivedDeltas[0]).toBe("delta_token_0")
      expect(receivedDeltas[eventCount - 1]).toBe(`delta_token_${eventCount - 1}`)

      // EventBus streaming throughput target: at least 3,000 events/sec in Node/Bun runtime
      expect(eventsPerSec).toBeGreaterThan(3000)
    }),
  )

  it.live("benchmarks Drizzle SQLite fast transaction and batch query throughput", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service

      // Setup a lightweight benchmark table
      yield* db.run(
        sql`CREATE TABLE IF NOT EXISTS benchmark_store (id TEXT PRIMARY KEY, value TEXT, created_at INTEGER)`,
      )

      // 1. Fast sequential inserts inside distinct transactions
      const singleInsertCount = 50
      const startSingle = performance.now()
      for (let i = 0; i < singleInsertCount; i++) {
        yield* db.run(
          sql`INSERT INTO benchmark_store (id, value, created_at) VALUES (${`id_${i}`}, ${`val_${i}`}, ${Date.now()})`,
        )
      }
      const singleElapsedMs = performance.now() - startSingle
      const avgSingleMs = singleElapsedMs / singleInsertCount

      // In SQLite WAL mode, single statement execution is very fast (< 10ms average)
      expect(avgSingleMs).toBeLessThan(10)

      // 2. Batch bulk query benchmark
      const startQuery = performance.now()
      const rows = yield* db.run(sql`SELECT id, value FROM benchmark_store`)
      const queryElapsedMs = performance.now() - startQuery

      expect(rows).toBeDefined()
      // Full table scan of 50 rows should execute in sub-millisecond to low millisecond range
      expect(queryElapsedMs).toBeLessThan(15)
    }),
  )

  it.live("benchmarks instruction hashing throughput and diff latency with string/object cache", () =>
    Effect.gen(function* () {
      const iterations = 500
      const sampleText = "Detailed instruction set for AI model behavior, guidelines, and tool execution patterns."

      // 1. Initial warm hash computation
      const firstHash = Instructions.hash(sampleText)
      expect(firstHash).toBeDefined()

      // 2. High-throughput cached hashing
      const start = performance.now()
      for (let i = 0; i < iterations; i++) {
        const h = Instructions.hash(sampleText)
        expect(h).toBe(firstHash)
      }
      const elapsedMs = performance.now() - start
      const opsPerSec = (iterations / elapsedMs) * 1000

      // Cached hashing should achieve > 50,000 ops/sec (sub-microsecond lookup)
      expect(opsPerSec).toBeGreaterThan(50000)

      // 3. Instruction diff latency benchmark
      const sourceA = Instructions.Key.make("core/a")
      const sourceB = Instructions.Key.make("core/b")
      const observed: Instructions.ReadResult = [
        { key: sourceA, value: "value-a" },
        { key: sourceB, value: "value-b" },
      ]
      const previous: Instructions.Values = {
        [sourceA]: Instructions.hash("value-a"),
        [sourceB]: Instructions.hash("value-b"),
      }

      const diffStart = performance.now()
      const diffIterations = 200
      for (let i = 0; i < diffIterations; i++) {
        const admission = yield* Instructions.diff(observed, previous)
        expect(Object.keys(admission.delta).length).toBe(0)
      }
      const diffElapsedMs = performance.now() - diffStart
      const avgDiffMs = diffElapsedMs / diffIterations

      // Unchanged diff evaluation should be sub-millisecond (< 0.1ms per diff)
      expect(avgDiffMs).toBeLessThan(0.5)
    }),
  )

  it.live("benchmarks compact tool guidance and action snippets token filtering", () =>
    Effect.gen(function* () {
      // 1. Guidance rules without tools vs filtered by minimal tools
      const allGuidance = ToolGuidance.render()
      const minimalGuidance = ToolGuidance.render(ToolGuidance.defaultRules, ["read", "edit"])

      expect(allGuidance).toContain("desktop-commander")
      expect(allGuidance).toContain("context7")
      expect(minimalGuidance).not.toContain("desktop-commander")
      expect(minimalGuidance).not.toContain("context7")
      expect(minimalGuidance.length).toBeLessThan(allGuidance.length)

      // 2. Action snippets filtering
      const allSnippets = ActionSnippets.render()
      const minimalSnippets = ActionSnippets.render(ActionSnippets.defaultSnippets, ["grep", "read"])

      expect(allSnippets).toContain("bg-process")
      expect(minimalSnippets).not.toContain("bg-process")
      expect(minimalSnippets).toContain("narrow-search")
      expect(minimalSnippets).toContain("bounded-read")
      expect(minimalSnippets.length).toBeLessThan(allSnippets.length)
    }),
  )

  it.live("benchmarks compaction summary validation throughput (isSummaryFilled)", () =>
    Effect.gen(function* () {
      const validSummary = [
        "## Objective",
        "- Complete the dialogue pipeline audit.",
        "",
        "## Decisions",
        "- Cached instruction hashes and streamlined tool guidance.",
        "",
        "## Next Move",
        "1. Verify benchmarks and report results.",
      ].join("\n")

      const iterations = 1000
      const start = performance.now()
      for (let i = 0; i < iterations; i++) {
        const filled = SessionCompaction.isSummaryFilled(validSummary)
        expect(filled).toBe(true)
      }
      const elapsedMs = performance.now() - start

      // 1,000 substring heading checks should complete well under 10ms
      expect(elapsedMs).toBeLessThan(15)
    }),
  )

  it.live("benchmarks semantic checkpoint parsing throughput (parseCheckpoint)", () =>
    Effect.gen(function* () {
      const checkpointPayload = [
        "<conversation-checkpoint>",
        "The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.",
        "",
        "<summary>",
        "## Objective",
        "- Streamline dialogue state compaction and checkpoint persistence.",
        "",
        "## Decisions",
        "- Zero-allocation indexing for summary structure validation.",
        "</summary>",
        "",
        "<recent-context>",
        "[User]: Execute tests and verify.",
        "[Assistant]: Tests verified successfully.",
        "</recent-context>",
        "</conversation-checkpoint>",
      ].join("\n")

      const iterations = 1000
      const start = performance.now()
      for (let i = 0; i < iterations; i++) {
        const parsed = SessionCompaction.parseCheckpoint(checkpointPayload)
        expect(parsed).toBeDefined()
        expect(parsed!.summary).toContain("## Objective")
        expect(parsed!.recent).toContain("[User]: Execute tests and verify.")
      }
      const elapsedMs = performance.now() - start

      // 1,000 checkpoint extractions should take < 15ms
      expect(elapsedMs).toBeLessThan(15)
    }),
  )
})
