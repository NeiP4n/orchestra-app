import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Logger, Stream } from "effect"
import { LanguageModel, LLMEvent, LLMRequest } from "@orchestra/ai"
import { OpenAIChat } from "@orchestra/ai/protocols/openai-chat"
import { TestLLM } from "@orchestra/ai/testing"
import { Agent } from "@orchestra/core/agent"
import { Bus } from "@orchestra/core/bus"
import { Database } from "@orchestra/core/database/database"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNodePlatform } from "@orchestra/core/effect/app-node-platform"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { SessionMemory } from "@orchestra/core/memory/session"
import { Session } from "@orchestra/core/session"
import { SessionEvent } from "@orchestra/core/session/event"
import { SessionMessage } from "@orchestra/core/session/message"
import { SessionRunnerLLM } from "@orchestra/core/session/runner/llm"
import { SessionRunnerModel } from "@orchestra/core/session/runner/model"
import { SessionStep } from "@orchestra/core/session/runner/step"
import { Snapshot } from "@orchestra/core/snapshot"
import { ToolOutput } from "@orchestra/core/tool-output"

// Integrated settle fixture (G1/T10): one valid project directory, the real
// SessionStep attempt, the real llm.ts onToolSettled wiring, a fake LLM and a
// fabricated tool execution. Asserts that an engine-open failure cannot block
// the tool-result publication, that the scrubbed journal stays the record,
// and that the degradation warning fires once per failure streak.

const model = LanguageModel.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})

const sessionID = Session.ID.make("ses_settle_capture")
const assistantMessageID = SessionMessage.ID.make("msg_settle_capture")

const toolOutput = Layer.mock(ToolOutput.Service, { truncate: (result) => Effect.succeed(result) })
const testLLM = TestLLM.layer({ fallback: [] })
const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, Bus.node, LayerNodePlatform.llmClient, Snapshot.node, ToolOutput.node]), [
  Snapshot.node.replace(Snapshot.noopLayer),
  ToolOutput.node.replace(toolOutput),
  LayerNodePlatform.llmClient.replace(TestLLM.clientLayer.pipe(Layer.provide(testLLM))),
]).pipe(Layer.provideMerge(testLLM))

const project = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-settle-capture-"))
  // The engine database path exists as a DIRECTORY, so opening the sqlite
  // engine fails operationally while the journal directory stays writable.
  await mkdir(path.join(directory, ".orchestra", "memory.db"), { recursive: true })
  return directory
}

describe("session settle capture (integrated step fixture)", () => {
  test("a settled tool publishes its result once, appends the scrubbed journal entry and warns once", async () => {
    const directory = await project()
    const warnings: string[] = []
    const captureLogs = Effect.provideService(
      Logger.CurrentLoggers,
      new Set([
        Logger.make(({ message }) => {
          warnings.push(Array.isArray(message) ? message.map(String).join(" ") : String(message))
        }),
      ]),
    )

    const program = Effect.gen(function* () {
      const bus = yield* Bus.Service
      const llm = yield* TestLLM.Service
      const steps = yield* SessionStep.make

      const successes: string[] = []
      yield* bus.subscribe(SessionEvent.Tool.Success).pipe(
        Stream.runForEach((event) => Effect.sync(() => void successes.push(event.data.id))),
        Effect.forkScoped,
      )

      yield* llm.push(
        TestLLM.complete(
          { reason: { normalized: "tool-calls" } },
          LLMEvent.toolCall({ id: "call-1", name: "edit", input: { text: "edit config.ts adding the SECRET-token value" } }),
        ),
      )

      const outcome = yield* steps.attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model: resolved,
        prepared: {
          request: new LLMRequest({ model, system: [], messages: [], tools: [] }),
          options: {},
          retry: () => Effect.void,
          executeTool: ({ call }) =>
            Effect.succeed({ content: [{ type: "text" as const, text: "edited config.ts with the new SECRET-token value" }] }),
        },
        retry: () => Effect.succeed({ retry: false as const }),
        recoverContinuation: false,
        recoverOverflow: Effect.succeed(false),
        fallback: () => Effect.succeed(false),
        onToolSettled: SessionRunnerLLM.toolSettledCapture(directory, sessionID, (text) => text.replaceAll("SECRET-token", "[scrubbed]")),
      })
      return { outcome, successes }
    })

    const { outcome, successes } = await Effect.runPromise(Effect.scoped(program).pipe(captureLogs, Effect.provide(layer)))

    expect(outcome._tag).toBe("Completed")
    expect(successes).toEqual(["call-1"])

    const journal = await readFile(SessionMemory.pathsFor(directory, sessionID).journal, "utf8")
    expect(journal).toContain("[scrubbed]")
    expect(journal).not.toContain("SECRET-token")

    const engineWarnings = warnings.filter((line) => line.includes("Session memory engine"))
    expect(engineWarnings).toHaveLength(1)
    expect(engineWarnings[0]).toContain("failed to open")
    expect(engineWarnings[0]).toContain("retried on the next settled tool call")

    // The blocker directory is untouched: no engine was created.
    expect((await stat(path.join(directory, ".orchestra", "memory.db"))).isDirectory()).toBe(true)

    await rm(directory, { recursive: true, force: true })
  })

  test("a second settle retries the open without a duplicate warning, and the engine recovers once the blockage is removed", async () => {
    const directory = await project()
    const warnings: string[] = []
    const captureLogs = Effect.provideService(
      Logger.CurrentLoggers,
      new Set([
        Logger.make(({ message }) => {
          warnings.push(Array.isArray(message) ? message.map(String).join(" ") : String(message))
        }),
      ]),
    )
    const scrub = (text: string) => text
    const callback = SessionRunnerLLM.toolSettledCapture(directory, sessionID, scrub)
    const event = (id: string) => ({
      id,
      name: "edit",
      inputText: `edit config.ts adding value ${id}`,
      outputText: `edited config.ts with value ${id}`,
    })

    await Effect.runPromise(Effect.scoped(callback(event("call-a"))).pipe(captureLogs, Effect.provide(layer)))
    await Effect.runPromise(Effect.scoped(callback(event("call-b"))).pipe(captureLogs, Effect.provide(layer)))
    expect(warnings.filter((line) => line.includes("Session memory engine failed to open"))).toHaveLength(1)

    // Both settles still reached the journal while the engine was down.
    const journal = await readFile(SessionMemory.pathsFor(directory, sessionID).journal, "utf8")
    expect(journal).toContain("edit config.ts adding value call-a")
    expect(journal).toContain("edit config.ts adding value call-b")

    // Recovery: with the blockage gone the next settle opens the real engine
    // and records through it.
    await rm(path.join(directory, ".orchestra", "memory.db"), { recursive: true, force: true })
    await Effect.runPromise(Effect.scoped(callback(event("call-c"))).pipe(captureLogs, Effect.provide(layer)))
    const engine = SessionMemory.openSessionEngine(directory)
    expect(engine.stats().observations).toBeGreaterThanOrEqual(1)
    engine.close()

    await rm(directory, { recursive: true, force: true })
  })

  test("an arbitrary synchronous throw in the settle callback cannot block the tool-result publication", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-settle-throw-"))

    const program = Effect.gen(function* () {
      const bus = yield* Bus.Service
      const llm = yield* TestLLM.Service
      const steps = yield* SessionStep.make

      const successes: string[] = []
      yield* bus.subscribe(SessionEvent.Tool.Success).pipe(
        Stream.runForEach((event) => Effect.sync(() => void successes.push(event.data.id))),
        Effect.forkScoped,
      )

      yield* llm.push(
        TestLLM.complete(
          { reason: { normalized: "tool-calls" } },
          LLMEvent.toolCall({ id: "call-9", name: "echo", input: { text: "boom" } }),
        ),
      )

      const outcome = yield* steps.attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model: resolved,
        prepared: {
          request: new LLMRequest({ model, system: [], messages: [], tools: [] }),
          options: {},
          retry: () => Effect.void,
          executeTool: () => Effect.succeed({ content: [{ type: "text" as const, text: "echoed boom" }] }),
        },
        retry: () => Effect.succeed({ retry: false as const }),
        recoverContinuation: false,
        recoverOverflow: Effect.succeed(false),
        fallback: () => Effect.succeed(false),
        onToolSettled: () => {
          throw new Error("synchronous callback defect")
        },
      })
      return { outcome, successes }
    })

    const { outcome, successes } = await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer)))
    expect(outcome._tag).toBe("Completed")
    expect(successes).toEqual(["call-9"])

    await rm(directory, { recursive: true, force: true })
  })
})
