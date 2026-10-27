import { describe, expect, test } from "bun:test"
import { Agent } from "@orchestra/schema/agent"
import { Model } from "@orchestra/schema/model"
import { Money } from "@orchestra/schema/money"
import { Project } from "@orchestra/schema/project"
import { Provider } from "@orchestra/schema/provider"
import { Session } from "@orchestra/schema/session"
import { SessionEvent } from "@orchestra/schema/session-event"
import { SessionMessage } from "@orchestra/schema/session-message"
import { AbsolutePath } from "@orchestra/core/schema"
import { Bus } from "@orchestra/core/bus"
import { Database } from "@orchestra/core/database/database"
import { ProjectTable } from "@orchestra/core/project/sql"
import { SessionMessageTable, SessionTable } from "@orchestra/core/session/sql"
import { SessionStats } from "@orchestra/core/session/stats"
import { Token } from "@orchestra/core/util/token"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { DateTime, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
)
const projectID = Project.ID.make("stats-project")
const otherProjectID = Project.ID.make("stats-other-project")
const sessionID = Session.ID.make("ses_stats_root")
const childID = Session.ID.make("ses_stats_child")
const forkID = Session.ID.make("ses_stats_fork")
const usageOnlyID = Session.ID.make("ses_stats_usage_only")
const otherSessionID = Session.ID.make("ses_stats_other")
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

describe("SessionStats", () => {
  it.effect("aggregates activity and tool reliability without reading message payloads outside the range", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values([
          { id: projectID, worktree: AbsolutePath.make("/stats"), name: "stats", sandboxes: [] },
          { id: otherProjectID, worktree: AbsolutePath.make("/other"), name: "other", sandboxes: [] },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values([
          { id: sessionID, project_id: projectID, slug: "root", directory: "/stats", version: "test" },
          {
            id: childID,
            project_id: projectID,
            parent_id: sessionID,
            slug: "child",
            directory: "/stats",
            version: "test",
          },
          {
            id: forkID,
            project_id: projectID,
            fork_session_id: sessionID,
            slug: "fork",
            directory: "/stats",
            version: "test",
            time_created: Date.UTC(2026, 0, 4),
          },
          { id: usageOnlyID, project_id: projectID, slug: "usage", directory: "/stats", version: "test" },
          { id: otherSessionID, project_id: otherProjectID, slug: "other", directory: "/other", version: "test" },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          messageRow(
            sessionID,
            1,
            SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_stats_user"),
              type: "user",
              text: "hello",
              time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 9)) },
            }),
          ),
          messageRow(
            sessionID,
            2,
            assistant("msg_stats_assistant", Date.UTC(2026, 0, 2, 10), [
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_read",
                name: "read",
                state: SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: {},
                  content: [{ type: "text", text: "ok" }],
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  ran: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1, 250)),
                },
              }),
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_edit",
                name: "edit",
                state: SessionMessage.ToolStateError.make({
                  status: "error",
                  input: {},
                  error: { type: "tool", message: "failed" },
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 2)),
                },
              }),
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_pending",
                name: "pending",
                state: SessionMessage.ToolStateRunning.make({ status: "running", input: {}, metadata: {} }),
                time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)) },
              }),
            ]),
          ),
          messageRow(childID, 1, assistant("msg_stats_child", Date.UTC(2026, 0, 3, 10), [], "large", 2)),
          messageRow(
            forkID,
            1,
            SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_stats_fork_copied_user"),
              type: "user",
              text: "copied",
              time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 9)) },
            }),
          ),
          messageRow(
            forkID,
            2,
            assistant("msg_stats_fork_copied_assistant", Date.UTC(2026, 0, 2, 10), [
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_copied",
                name: "copied",
                state: SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: {},
                  content: [{ type: "text", text: "copied" }],
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1)),
                },
              }),
            ]),
          ),
          messageRow(forkID, 3, assistant("msg_stats_fork_new", Date.UTC(2026, 0, 5, 10), [], "fork-new")),
          messageRow(sessionID, 3, assistant("msg_stats_outside", Date.UTC(2025, 11, 31, 10), [])),
          messageRow(usageOnlyID, 1, assistant("msg_stats_usage_only", Date.UTC(2025, 11, 30, 10), [])),
          messageRow(otherSessionID, 1, assistant("msg_stats_other", Date.UTC(2020, 0, 1, 10), [])),
        ])
        .run()
        .pipe(Effect.orDie)
      // Publish through the real Bus so the stored event type is whatever the
      // writer persists rather than a string the test assumes.
      const bus = yield* Bus.Service
      yield* TestClock.setTime(Date.UTC(2026, 0, 2, 10, 0, 3))
      yield* bus.publish(SessionEvent.UsageRecorded, {
        sessionID,
        source: "title",
        cost: Money.USD.make(0.5),
        tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 1, write: 1 } },
      })
      yield* bus.publish(SessionEvent.UsageRecorded, {
        sessionID: usageOnlyID,
        source: "compaction",
        cost: Money.USD.make(0.25),
        tokens: { input: 2, output: 2, reasoning: 2, cache: { read: 2, write: 2 } },
      })

      const stats = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
        tools: "detail",
      })

      expect(stats.sessions).toBe(2)
      expect(stats.subagents).toBe(1)
      expect(stats.prompts).toBe(1)
      expect(stats.steps).toBe(3)
      expect(stats.tokens).toEqual({ input: 42, output: 22, reasoning: 10, cache: { read: 18, write: 6 } })
      expect(stats.cost).toBe(Money.USD.make(6.25))
      expect(stats.tools).toMatchObject({
        mode: "detail",
        totals: { calls: 3, succeeded: 1, failed: 1, unfinished: 1 },
      })
      expect(stats.activity).toEqual([
        { date: "2026-01-02", steps: 1 },
        { date: "2026-01-03", steps: 1 },
        { date: "2026-01-05", steps: 1 },
      ])
      expect(stats.streak).toBe(2)
      expect(stats.models.map((model) => String(model.model.id))).toEqual(["large", "sonnet", "fork-new"])
      expect(stats.tools.mode).toBe("detail")
      if (stats.tools.mode !== "detail") throw new Error("Expected detailed tool statistics")
      expect(stats.tools.usage).toMatchObject([
        { name: "read", calls: 1, succeeded: 1, failed: 0, durationP50: 250 },
        { name: "edit", calls: 1, succeeded: 0, failed: 1, durationP50: 2_000 },
        { name: "pending", calls: 1, succeeded: 0, failed: 0, unfinished: 1 },
      ])

      const summary = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
      })
      expect(summary.models.map((model) => String(model.model.id))).toEqual(["large", "sonnet", "fork-new"])
      expect(summary.tools).toEqual({
        mode: "summary",
        totals: { calls: 3, succeeded: 1, failed: 1, unfinished: 1 },
      })

      const withoutTools = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
        tools: "none",
      })
      expect(withoutTools.tools).toEqual({ mode: "none" })

      const project = yield* SessionStats.get({ projectID, timezone: "UTC", tools: "none" })
      expect(DateTime.toEpochMillis(project.range.from)).toBe(Date.UTC(2025, 11, 30, 10))

      const error = yield* Effect.flip(
        SessionStats.get({ from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 0, 1), tools: "none" }),
      )
      expect(error).toEqual(
        new SessionStats.InvalidRangeError({ from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 0, 1) }),
      )

      const future = yield* Effect.flip(SessionStats.get({ from: Number.MAX_SAFE_INTEGER, tools: "none" }))
      expect(future._tag).toBe("SessionStats.InvalidRangeError")
    }),
  )

  test("Token.calculateBudget calculates context utilization and triggers preemptive warnings", () => {
    // Safe (<80%)
    const safe = Token.calculateBudget({ contextLimit: 100_000, usedTokens: 50_000, reserveOutput: 10_000 })
    expect(safe.window).toBe(100_000)
    expect(safe.used).toBe(50_000)
    expect(safe.available).toBe(40_000)
    expect(safe.utilization).toBe(0.5556)
    expect(safe.status).toBe("safe")
    expect(safe.warning).toBeUndefined()

    // Warning (>=80% and <95%)
    const warning = Token.calculateBudget({ contextLimit: 100_000, usedTokens: 81_000 })
    expect(warning.status).toBe("warning")
    expect(warning.utilization).toBe(0.81)
    expect(warning.warning).toContain("Context limit warning: 81.0% used")

    // Critical (>=95% and <=100%)
    const critical = Token.calculateBudget({ contextLimit: 100_000, usedTokens: 96_000 })
    expect(critical.status).toBe("critical")
    expect(critical.utilization).toBe(0.96)
    expect(critical.warning).toContain("Context limit critical: 96.0% used")

    // Exceeded (>100%)
    const exceeded = Token.calculateBudget({ contextLimit: 100_000, usedTokens: 105_000 })
    expect(exceeded.status).toBe("exceeded")
    expect(exceeded.available).toBe(0)
    expect(exceeded.warning).toContain("Context limit exceeded: used 105000 tokens")
  })

  test("Token.formatCount and Token.estimateBytes format memory and token quantities", () => {
    expect(Token.formatCount(500)).toBe("500")
    expect(Token.formatCount(12_500)).toBe("12.5k")
    expect(Token.formatCount(1_500_000)).toBe("1.5M")
    expect(Token.estimateBytes(1_000)).toBe(4_000)
  })

  test("SessionStats.sessionBudget analyzes message token usage and evaluates context limits", () => {
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_user_1"),
        type: "user",
        text: "first query",
        time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 1)) },
      }),
      assistant("msg_assistant_1", Date.UTC(2026, 0, 1), [], "sonnet", 1),
      assistant("msg_assistant_2", Date.UTC(2026, 0, 1, 1), [], "sonnet", 2),
    ]

    const report = SessionStats.sessionBudget(messages, { context: 100, input: 100, output: 20 })
    expect(report.stepCount).toBe(2)
    // Scale 1: 10 in + 5 out + 2 reasoning + 4 cacheRead + 1 cacheWrite = 22
    // Scale 2: 20 in + 10 out + 4 reasoning + 8 cacheRead + 2 cacheWrite = 44
    // Total = 66
    expect(report.sessionTokens.input).toBe(30)
    expect(report.sessionTokens.output).toBe(15)
    expect(report.sessionTokens.reasoning).toBe(6)
    expect(report.sessionTokens.cache.read).toBe(12)
    expect(report.sessionTokens.cache.write).toBe(3)
    expect(report.sessionTokens.total).toBe(66)
    expect(report.budget).toBeDefined()
    expect(report.budget?.used).toBe(66)
    expect(report.budget?.available).toBe(34)
    expect(report.budget?.status).toBe("safe")

    // With a tighter limit triggering warning:
    const warningReport = SessionStats.sessionBudget(messages, { context: 75, input: 75, output: 10 })
    expect(warningReport.budget?.status).toBe("warning")
    expect(warningReport.budget?.warning).toContain("Context limit warning")
  })
})

function assistant(
  id: string,
  created: number,
  content: SessionMessage.AssistantContent[],
  model = "sonnet",
  scale = 1,
) {
  return SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: { id: Model.ID.make(model), providerID: Provider.ID.make("anthropic") },
    content,
    cost: Money.USD.make(1.5 * scale),
    tokens: { input: 10 * scale, output: 5 * scale, reasoning: 2 * scale, cache: { read: 4 * scale, write: scale } },
    time: { created: DateTime.makeUnsafe(created), completed: DateTime.makeUnsafe(created + 2_000) },
  })
}

function messageRow(
  sessionID: Session.ID,
  seq: number,
  message: SessionMessage.Info,
): typeof SessionMessageTable.$inferInsert {
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq, time_created: encoded.time.created, data }
}
