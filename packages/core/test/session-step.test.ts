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
import { Effect, Exit, Fiber, Layer } from "effect"
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
      const metricReceipts: unknown[] = []
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
          onUsageSettled: tokens => Effect.sync(()=>{metricReceipts.push(tokens)}),
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
      expect(metricReceipts).toEqual(fixture.finish === "stop" ? [{input:10,output:4,reasoning:2,cacheRead:3,cacheWrite:2}] : [])
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

// Step 0 measurement through the real step seam: the attempt identity travels on Prepared,
// every outcome branch settles it, unknown usage/price stays null, and only the runner's
// explicit retry token links a retry to the logical request it continues.
const measurementFixture = (options?: { readonly priced?: boolean }) =>
  Effect.gen(function* () {
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
        cost:
          options?.priced === false
            ? []
            : [
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
    const attemptInput = (measurement?: SessionRequestMeasurement.RetryToken) => ({
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
        ...(measurement === undefined ? {} : { measurement }),
      },
      retry: (_cause: AIError, _error: unknown, retry: boolean) =>
        Effect.succeed(retry ? { retry: true as const, attempt: 2, delay: 0 } : { retry: false as const }),
      recoverContinuation: false,
      recoverOverflow: Effect.succeed(false),
      fallback: () => Effect.succeed(false),
    })
    const enable = () => {
      process.env.ORCHESTRA_REQUEST_MEASUREMENT = "1"
      process.env.ORCHESTRA_REQUEST_MEASUREMENT_DIR = dir
    }
    return { llm, sessionID, steps, dir, sizesRequest, attemptInput, enable }
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

const exportedRecords = (dir: string) =>
  SessionRequestMeasurement.readExport(dir).pipe(
    Effect.map((exported) => ({
      unfinished: exported.manifest.unfinished,
      records: exported.lines.map((line) => JSON.parse(line)),
    })),
  )

it.effect("measurement: a retry settles the failed attempt and the runner's token links the next one", () =>
  withMeasurement(
    Effect.gen(function* () {
      const { llm, sessionID, steps, dir, sizesRequest, attemptInput, enable } = yield* measurementFixture()
      enable()
      const first = yield* SessionRequestMeasurement.recordPrimarySizes({ sessionID, request: sizesRequest })
      expect(first).toBeDefined()
      yield* llm.push(TestLLM.failAfter(new AIError({ reason: new RateLimitError({ message: "Too many requests" }) })))
      const retried = yield* steps.attempt(attemptInput(first)).pipe(Effect.exit)
      expect(Exit.isSuccess(retried)).toBe(true)
      if (Exit.isSuccess(retried)) expect(retried.value._tag).toBe("Retry")

      // The runner hands the failed attempt's identity back as the explicit retry token.
      const second = yield* SessionRequestMeasurement.recordPrimarySizes({
        sessionID,
        request: sizesRequest,
        retryOf: first,
      })
      expect(second).toBeDefined()
      expect(second!.attemptID).not.toBe(first!.attemptID)
      yield* llm.push(TestLLM.textWithUsage("done", "msg-1", 15))
      const completed = yield* steps.attempt(attemptInput(second)).pipe(Effect.exit)
      expect(Exit.isSuccess(completed)).toBe(true)

      const { unfinished, records } = yield* exportedRecords(dir)
      expect(records).toHaveLength(2)
      expect(unfinished).toBe(0)
      const failed = records.find((record) => record.attemptID === first!.attemptID)
      const retriedRecord = records.find((record) => record.attemptID === second!.attemptID)
      expect(failed.outcome).toBe("failed")
      expect(failed.usage.input).toBeNull()
      expect(retriedRecord.outcome).toBe("completed")
      expect(retriedRecord.retryOf).toBe(first!.attemptID)
      expect(retriedRecord.logicalRequestID).toBe(first!.logicalRequestID)
      // Raw presence: the provider reported only nonCachedInputTokens, and partial usage
      // cannot be priced - the estimate stays null instead of pretending a zero total.
      expect(retriedRecord.usage.input).toBe(15)
      expect(retriedRecord.usage.output).toBeNull()
      expect(retriedRecord.cost).toEqual({ recordedUSD: null, estimatedUSD: null, source: "unknown" })
    }),
  ),
)

it.effect("measurement: a completion without provider usage keeps usage and cost unknown", () =>
  withMeasurement(
    Effect.gen(function* () {
      const { llm, sessionID, steps, dir, sizesRequest, attemptInput, enable } = yield* measurementFixture()
      enable()
      const attempt = yield* SessionRequestMeasurement.recordPrimarySizes({ sessionID, request: sizesRequest })
      yield* llm.push(TestLLM.text("done", "msg-1"))
      const result = yield* steps.attempt(attemptInput(attempt)).pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(true)
      const { records } = yield* exportedRecords(dir)
      const record = records.find((entry) => entry.attemptID === attempt!.attemptID)
      expect(record.outcome).toBe("completed")
      expect(record.usage).toEqual({ input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null })
      expect(record.cost).toEqual({ recordedUSD: null, estimatedUSD: null, source: "unknown" })
    }),
  ),
)

const completeUsageResponse = TestLLM.complete(
  {
    reason: { normalized: "stop" },
    usage: {
      inputTokens: 20,
      nonCachedInputTokens: 15,
      outputTokens: 6,
      reasoningTokens: 2,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 2,
    },
  },
  LLMEvent.textStart({ id: "t-1" }),
  LLMEvent.textDelta({ id: "t-1", text: "done" }),
  LLMEvent.textEnd({ id: "t-1" }),
)

it.effect("measurement: a model without a price tier keeps the estimated cost null, not zero", () =>
  withMeasurement(
    Effect.gen(function* () {
      const { llm, sessionID, steps, dir, sizesRequest, attemptInput, enable } = yield* measurementFixture({
        priced: false,
      })
      enable()
      const attempt = yield* SessionRequestMeasurement.recordPrimarySizes({ sessionID, request: sizesRequest })
      yield* llm.push(completeUsageResponse)
      const result = yield* steps.attempt(attemptInput(attempt)).pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(true)
      const { records } = yield* exportedRecords(dir)
      const record = records.find((entry) => entry.attemptID === attempt!.attemptID)
      expect(record.outcome).toBe("completed")
      expect(record.usage.input).toBe(15)
      expect(record.cost).toEqual({ recordedUSD: null, estimatedUSD: null, source: "unknown" })
    }),
  ),
)

it.effect("measurement: complete usage prices from the catalog and output excludes reasoning", () =>
  withMeasurement(
    Effect.gen(function* () {
      const { llm, sessionID, steps, dir, sizesRequest, attemptInput, enable } = yield* measurementFixture()
      enable()
      const attempt = yield* SessionRequestMeasurement.recordPrimarySizes({ sessionID, request: sizesRequest })
      yield* llm.push(completeUsageResponse)
      const result = yield* steps.attempt(attemptInput(attempt)).pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(true)
      const { records } = yield* exportedRecords(dir)
      const record = records.find((entry) => entry.attemptID === attempt!.attemptID)
      expect(record.outcome).toBe("completed")
      // Visible output is 6 - 2 reasoning; summing output + reasoning gives the inclusive total.
      expect(record.usage).toEqual({ input: 15, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 2 })
      // (15 * $1 + 6 * $2 + 3 * $0.1 + 2 * $0.5) / 1e6
      expect(record.cost.estimatedUSD).toBeCloseTo(0.0000283, 10)
      expect(record.cost.source).toBe("catalog")
    }),
  ),
)

it.effect("measurement: an empty usage report keeps every field and the cost unknown", () =>
  withMeasurement(
    Effect.gen(function* () {
      const { llm, sessionID, steps, dir, sizesRequest, attemptInput, enable } = yield* measurementFixture()
      enable()
      const attempt = yield* SessionRequestMeasurement.recordPrimarySizes({ sessionID, request: sizesRequest })
      yield* llm.push(TestLLM.complete({ reason: { normalized: "stop" }, usage: {} }))
      const result = yield* steps.attempt(attemptInput(attempt)).pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(true)
      const { records } = yield* exportedRecords(dir)
      const record = records.find((entry) => entry.attemptID === attempt!.attemptID)
      expect(record.outcome).toBe("completed")
      expect(record.usage).toEqual({ input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null })
      expect(record.cost).toEqual({ recordedUSD: null, estimatedUSD: null, source: "unknown" })
    }),
  ),
)

it.effect("measurement: output excludes reasoning when the split is known, unknown when it is not", () =>
  withMeasurement(
    Effect.gen(function* () {
      const { llm, sessionID, steps, dir, sizesRequest, attemptInput, enable } = yield* measurementFixture()
      enable()
      // Known split: visible output is 100 - 40, never the inclusive 100.
      const split = yield* SessionRequestMeasurement.recordPrimarySizes({ sessionID, request: sizesRequest })
      yield* llm.push(
        TestLLM.complete({
          reason: { normalized: "stop" },
          usage: {
            inputTokens: 10,
            nonCachedInputTokens: 10,
            outputTokens: 100,
            reasoningTokens: 40,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
          },
        }),
      )
      const splitResult = yield* steps.attempt(attemptInput(split)).pipe(Effect.exit)
      expect(Exit.isSuccess(splitResult)).toBe(true)
      // Missing split: output stays unknown rather than counting reasoning twice.
      const unsplit = yield* SessionRequestMeasurement.recordPrimarySizes({ sessionID, request: sizesRequest })
      yield* llm.push(
        TestLLM.complete({
          reason: { normalized: "stop" },
          usage: { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 100 },
        }),
      )
      const unsplitResult = yield* steps.attempt(attemptInput(unsplit)).pipe(Effect.exit)
      expect(Exit.isSuccess(unsplitResult)).toBe(true)
      const { records } = yield* exportedRecords(dir)
      const splitRecord = records.find((entry) => entry.attemptID === split!.attemptID)
      expect(splitRecord.usage.output).toBe(60)
      expect(splitRecord.usage.reasoning).toBe(40)
      // (10 * $1 + 100 * $2) / 1e6 - pricing uses the inclusive total, so it stays complete.
      expect(splitRecord.cost.estimatedUSD).toBeCloseTo(0.00021, 10)
      const unsplitRecord = records.find((entry) => entry.attemptID === unsplit!.attemptID)
      expect(unsplitRecord.usage.output).toBeNull()
      expect(unsplitRecord.usage.reasoning).toBeNull()
    }),
  ),
)

// The clock must be live here: it.effect runs on TestClock, which never advances the sleep
// before Fiber.interrupt on its own.
it.live("measurement: interrupting the step settles the attempt as cancelled", () =>
  withMeasurement(
    Effect.gen(function* () {
      const { llm, sessionID, steps, dir, sizesRequest, attemptInput, enable } = yield* measurementFixture()
      enable()
      const attempt = yield* SessionRequestMeasurement.recordPrimarySizes({ sessionID, request: sizesRequest })
      yield* llm.push(TestLLM.hangAfter())
      const fiber = yield* Effect.forkDetach(steps.attempt(attemptInput(attempt)))
      yield* Effect.sleep("100 millis")
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true)
      const { records } = yield* exportedRecords(dir)
      const record = records.find((entry) => entry.attemptID === attempt!.attemptID)
      expect(record.outcome).toBe("cancelled")
    }),
  ),
)
