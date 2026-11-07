import { expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AIError, LanguageModel, LLM, LLMEvent, RateLimitError } from "@orchestra/ai"
import { OpenAIChat } from "@orchestra/ai/protocols/openai-chat"
import { TestLLM } from "@orchestra/ai/testing"
import { Agent } from "@orchestra/core/agent"
import { Bus } from "@orchestra/core/bus"
import { Database } from "@orchestra/core/database/database"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { EventTable } from "@orchestra/core/event/sql"
import { Project } from "@orchestra/core/project"
import { ProjectTable } from "@orchestra/core/project/sql"
import { AbsolutePath, RelativePath } from "@orchestra/core/schema"
import { Session } from "@orchestra/core/session"
import { SessionMessage } from "@orchestra/core/session/message"
import { SessionProjector } from "@orchestra/core/session/projector"
import { SessionRequestMeasurement } from "@orchestra/core/session/request-measurement"
import { SessionRunnerModel } from "@orchestra/core/session/runner/model"
import { SessionStep } from "@orchestra/core/session/runner/step"
import { SessionMessageTable, SessionTable } from "@orchestra/core/session/sql"
import { Snapshot } from "@orchestra/core/snapshot"
import { ToolOutput } from "@orchestra/core/tool-output"
import { Money } from "@orchestra/schema/money"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { asc, eq } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, ToolOutput.node]), [
      Bus.node.replace(Bus.configured({ persist: true })),
    ]),
    TestLLM.testLayer(),
  ),
)

for (const fixture of [
  { finish: "stop", toolChoice: undefined },
  { finish: "content-filter", toolChoice: undefined },
  { finish: "stop", toolChoice: "none" },
] as const) {
  it.effect(`settles ${fixture.finish} with tool choice ${fixture.toolChoice ?? "default"}`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const llm = yield* TestLLM.Test
      const sessionID = Session.ID.create()
      const assistantMessageID = SessionMessage.ID.create()
      const start = Snapshot.ID.make("before")
      const end = Snapshot.ID.make("after")
      const files = [RelativePath.make("changed.ts")]
      let captures = 0
      let executions = 0
      const steps = yield* SessionStep.make.pipe(
        Effect.provide(
          Layer.mock(Snapshot.Service)({
            capture: () => Effect.sync(() => (captures++ === 0 ? start : end)),
            files: (input) => {
              expect(input).toEqual({ from: start, to: end })
              return Effect.succeed(files)
            },
          }),
        ),
      )
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
        .run()
      const model = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 100_000, output: 1_000 },
          cost: [
            {
              input: Money.USDPerMillionTokens.make(1),
              output: Money.USDPerMillionTokens.make(2),
              cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
            },
          ],
        },
      )
      yield* llm.push(
        TestLLM.complete(
          {
            reason: { normalized: fixture.finish },
            usage: {
              inputTokens: 15,
              outputTokens: 6,
              nonCachedInputTokens: 10,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 2,
              reasoningTokens: 2,
            },
          },
          LLMEvent.toolCall({ id: "call-test", name: "test", input: {} }),
        ),
      )
      const result = yield* steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          prepared: {
            retry: () => Effect.void,
            request: LLM.request({ model: model.model, prompt: "Run one tool", toolChoice: fixture.toolChoice }),
            options: {},
            executeTool: () =>
              Effect.sync(() => {
                executions++
                return { content: [{ type: "text", text: "Completed tool" }] }
              }),
          },
          retry: (_cause, _error, retry) =>
            Effect.succeed(retry ? { retry: true, attempt: 2, delay: 0 } : { retry: false }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
          fallback: () => Effect.succeed(false),
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(fixture.finish === "stop")
      expect(executions).toBe(fixture.toolChoice === "none" ? 0 : 1)
      if (Exit.isSuccess(result))
        expect(result.value).toEqual(
          SessionStep.Outcome.Completed({ needsContinuation: fixture.toolChoice !== "none" }),
        )
      expect(yield* llm.requests()).toHaveLength(1)
      expect(captures).toBe(2)
      const message = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
      expect(message?.data).toMatchObject({
        finish: fixture.finish,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
        snapshot: { start, end, files },
        content: [{ type: "tool", state: { status: fixture.toolChoice === "none" ? "error" : "completed" } }],
      })
      expect(message?.data).toHaveProperty("cost", expect.closeTo(0.0000233, 10))
      const events = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
      const types = events.map((event) => event.type)
      const terminal = fixture.finish === "stop" ? "session.step.ended.1" : "session.step.failed.1"
      expect(types.filter((type) => type === "session.step.streamed.1")).toHaveLength(1)
      expect(types.filter((type) => type === terminal)).toHaveLength(1)
      expect(types.indexOf("session.step.streamed.1")).toBeLessThan(types.indexOf(terminal))
      expect(
        types.indexOf(fixture.toolChoice === "none" ? "session.tool.failed.2" : "session.tool.success.2"),
      ).toBeLessThan(types.indexOf(terminal))
    }),
  )
}

// Step 0 measurement through the real step seam: the attempt ID travels on Prepared, every
// outcome branch settles it, and a retry links to the failed attempt it continues.
const measurementFixture = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const llm = yield* TestLLM.Test
  const sessionID = Session.ID.create()
  const steps = yield* SessionStep.make.pipe(
    Effect.provide(
      Layer.mock(Snapshot.Service)({
        capture: () => Effect.succeed(Snapshot.ID.make("snap")),
        files: () => Effect.succeed([]),
      }),
    ),
  )
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
    .run()
  const model = SessionRunnerModel.resolved(
    LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
    {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 100_000, output: 1_000 },
      cost: [
        {
          input: Money.USDPerMillionTokens.make(1),
          output: Money.USDPerMillionTokens.make(2),
          cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
        },
      ],
    },
  )
  const dir = mkdtempSync(path.join(tmpdir(), "measurement-step-"))
  const sizesRequest = {
    model: { provider: "test", id: "test-model" },
    system: [{ text: "system" }],
    tools: [],
    messages: [{ role: "user", content: "hi" }],
  }
  const attemptInput = (attemptID: string | undefined) => ({
    isLocationClosed: () => false,
    sessionID,
    assistantMessageID: SessionMessage.ID.create(),
    agent: Agent.defaultID,
    model,
    prepared: {
      retry: () => Effect.void,
      request: LLM.request({ model: model.model, prompt: "Hi" }),
      options: {},
      executeTool: () => Effect.die("no tools in this test"),
      ...(attemptID === undefined ? {} : { measurement: { attemptID } }),
    },
    retry: (_cause: AIError, _error: unknown, retry: boolean) =>
      Effect.succeed(retry ? { retry: true as const, attempt: 2, delay: 0 } : { retry: false as const }),
    recoverContinuation: false,
    recoverOverflow: Effect.succeed(false),
    fallback: () => Effect.succeed(false),
  })
  return { llm, sessionID, steps, dir, sizesRequest, attemptInput }
})

const withMeasurement = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        delete process.env.ORCHESTRA_REQUEST_MEASUREMENT
        delete process.env.ORCHESTRA_REQUEST_MEASUREMENT_DIR
        SessionRequestMeasurement.untrackAll()
      }),
    ),
  )

it.effect("measurement: a retry settles the failed attempt and the retried request links to it", () =>
  withMeasurement(
    Effect.gen(function* () {
      const { llm, sessionID, steps, dir, sizesRequest, attemptInput } = yield* measurementFixture
      process.env.ORCHESTRA_REQUEST_MEASUREMENT = "1"
      process.env.ORCHESTRA_REQUEST_MEASUREMENT_DIR = dir
      const first = yield* SessionRequestMeasurement.recordPrimarySizes({ sessionID, request: sizesRequest })
      expect(first).toBeDefined()
      yield* llm.push(TestLLM.failAfter(new AIError({ reason: new RateLimitError({ message: "Too many requests" }) })))
      const retried = yield* steps.attempt(attemptInput(first)).pipe(Effect.exit)
      expect(Exit.isSuccess(retried)).toBe(true)
      if (Exit.isSuccess(retried)) expect(retried.value._tag).toBe("Retry")

      const second = yield* SessionRequestMeasurement.recordPrimarySizes({ sessionID, request: sizesRequest })
      expect(second).toBeDefined()
      expect(second).not.toBe(first)
      yield* llm.push(TestLLM.textWithUsage("done", "msg-1", 15))
      const completed = yield* steps.attempt(attemptInput(second)).pipe(Effect.exit)
      expect(Exit.isSuccess(completed)).toBe(true)

      const exported = yield* SessionRequestMeasurement.readExport(dir)
      expect(exported.manifest.records).toBe(2)
      expect(exported.manifest.unfinished).toBe(0)
      const records = exported.lines.map((line) => JSON.parse(line))
      const failed = records.find((record) => record.attemptID === first)
      const retriedRecord = records.find((record) => record.attemptID === second)
      expect(failed.outcome).toBe("failed")
      expect(failed.usage.input).toBeNull()
      expect(retriedRecord.outcome).toBe("completed")
      expect(retriedRecord.retryOf).toBe(first)
      expect(retriedRecord.logicalRequestID).toBe(failed.logicalRequestID)
      expect(retriedRecord.usage.input).toBeGreaterThan(0)
    }),
  ),
)
