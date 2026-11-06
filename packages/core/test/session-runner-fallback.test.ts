import { describe, expect, test } from "bun:test"
import {
  AIError,
  AuthenticationError,
  ContentPolicyError,
  InvalidRequestError,
  LanguageModel,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
} from "@orchestra/ai"
import { OpenAIChat } from "@orchestra/ai/protocols/openai-chat"
import { TestLLM } from "@orchestra/ai/testing"
import { SessionModelsMetadataKey } from "@orchestra/schema/orchestra"
import { Agent } from "@orchestra/core/agent"
import { Bus } from "@orchestra/core/bus"
import { Config } from "@orchestra/core/config"
import { Database } from "@orchestra/core/database/database"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNodePlatform } from "@orchestra/core/effect/app-node-platform"
import { InstructionBuiltIns } from "@orchestra/core/instructions/builtins"
import { Instructions } from "@orchestra/core/instructions/index"
import { InstructionDiscovery } from "@orchestra/core/instruction-discovery"
import { Location } from "@orchestra/core/location"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import { McpInstructions } from "@orchestra/core/mcp/instructions"
import { Model } from "@orchestra/core/model"
import { NoteInstructions } from "@orchestra/core/note-instructions"
import { Permission } from "@orchestra/core/permission"
import { IdentityPlugin } from "@orchestra/core/plugin/identity"
import { OptimizePlugin } from "@orchestra/core/plugin/optimize"
import { PluginHooks } from "@orchestra/core/plugin/hooks"
import { Plugin } from "@orchestra/core/plugin"
import { PluginSupervisor } from "@orchestra/core/plugin/supervisor"
import { Project } from "@orchestra/core/project"
import { ProjectTable } from "@orchestra/core/project/sql"
import { Provider } from "@orchestra/core/provider"
import { ReferenceInstructions } from "@orchestra/core/reference/instructions"
import { AbsolutePath } from "@orchestra/core/schema"
import { Session } from "@orchestra/core/session"
import { SessionExecution } from "@orchestra/core/session/execution"
import { SessionProjector } from "@orchestra/core/session/projector"
import { SessionRunCoordinator } from "@orchestra/core/session/run-coordinator"
import { SessionRunner } from "@orchestra/core/session/runner/index"
import { SessionRunnerLLM } from "@orchestra/core/session/runner/llm"
import { MAIN_SESSION_FALLBACK_MODELS, mainSessionFallbackChain } from "@orchestra/core/session/runner/error-taxonomy"
import { SessionRunnerModel } from "@orchestra/core/session/runner/model"
import { SessionStore } from "@orchestra/core/session/store"
import { SessionTable } from "@orchestra/core/session/sql"
import { SkillInstructions } from "@orchestra/core/skill/instructions"
import { Snapshot } from "@orchestra/core/snapshot"
import { Tool } from "@orchestra/core/tool"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Effect, Exit, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { agentHost, host, modelHost, noProviders } from "./plugin/host"
import { promptLocationNode } from "./fixture/prompt-location"

const model = (input: string) => Model.Ref.parse(input)
const current = model("opencode/big-pickle")
const next = model("zen/glm-4.6")
const spare = model("opencode/minimax-free")

const failure = (reason: ConstructorParameters<typeof AIError>[0]["reason"]) => new AIError({ reason })

const fallback = (input: { cause: AIError; models?: ReadonlyArray<Model.Ref>; refused?: ReadonlyArray<Model.Ref> }) =>
  SessionRunnerLLM.fallbackModel({
    cause: input.cause,
    models: input.models ?? [next, spare],
    current,
    refused: new Set((input.refused ?? []).map((item) => `${item.providerID}/${item.id}#${item.variant ?? ""}`)),
  })

describe("SessionRunnerLLM.fallbackModel", () => {
  test("leaves a failure the retry policy can wait out to it", () => {
    const cause = failure(new ProviderInternalError({ message: "internal" }))
    expect(fallback({ cause })).toBeUndefined()
  })

  test("continues on the next model when the provider rejects the request outright", () => {
    const cause = failure(new InvalidRequestError({ message: "User location is not supported" }))
    expect(fallback({ cause })).toEqual(next)
  })

  test("continues on the next model when the address spent its free tier", () => {
    const cause = failure(
      new RateLimitError({
        message: "Rate limit exceeded. Please try again later.",
        body: JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Rate limit exceeded." } }),
      }),
    )
    expect(fallback({ cause })).toEqual(next)
    expect(fallback({ cause, models: [spare] })).toEqual(spare)
  })

  test("keeps an ordinary rate limit on the retry policy", () => {
    expect(fallback({ cause: failure(new RateLimitError({ message: "Too many requests" })) })).toBeUndefined()
  })

  test("does not dodge a content policy refusal with another model", () => {
    const cause = failure(new ContentPolicyError({ message: "The request was blocked by the provider's policy" }))
    expect(fallback({ cause })).toBeUndefined()
    expect(fallback({ cause, models: [next, spare] })).toBeUndefined()
  })

  test("does not hide a context overflow that survived compaction behind another model", () => {
    const cause = failure(
      new InvalidRequestError({ message: "This model's maximum context length is 128000 tokens", classification: "context-overflow" }),
    )
    expect(fallback({ cause })).toBeUndefined()
    expect(fallback({ cause, models: [next, spare] })).toBeUndefined()
  })

  test("main-session fallbacks use only working Anymodel models, never the dead flash model", () => {
    // The main session carries no operator-given list; llm.ts substitutes
    // MAIN_SESSION_FALLBACK_MODELS when it already runs on Anymodel.
    const mainFallbacks = MAIN_SESSION_FALLBACK_MODELS.map((ref) => model(ref))
    const cause = failure(new InvalidRequestError({ message: "model_not_found" }))
    expect(fallback({ cause, models: mainFallbacks })).toEqual(model("anymodel/sonnet-5"))
    expect(fallback({ cause, models: mainFallbacks, refused: [model("anymodel/sonnet-5")] })).toEqual(
      model("anymodel/anymodel-coder"),
    )
    expect(
      fallback({
        cause,
        models: mainFallbacks,
        refused: [model("anymodel/sonnet-5"), model("anymodel/anymodel-coder")],
      }),
    ).toEqual(model("anymodel/gemini-3.8-flash"))
    expect(fallback({ cause, models: mainFallbacks, refused: mainFallbacks })).toBeUndefined()
    expect(MAIN_SESSION_FALLBACK_MODELS).not.toContain("anymodel/anymodel-v4.1-flash")
  })

  test("never picks the same model with another variant (C-7)", () => {
    // B14 saw "sonnet-5 → sonnet-5": another variant of the same model is the
    // same model, and on a 401 it fails exactly the same way.
    const cause = failure(new InvalidRequestError({ message: "model_not_found" }))
    expect(fallback({ cause, models: [model("opencode/big-pickle#max")] })).toBeUndefined()
    expect(fallback({ cause, models: [model("opencode/big-pickle#max"), next] })).toEqual(next)
    const auth = failure(new AuthenticationError({ message: "Unauthorized" }))
    expect(fallback({ cause: auth, models: [model("opencode/big-pickle#max"), spare] })).toEqual(spare)
  })

  test("a refusal of one variant refuses the whole model", () => {
    const cause = failure(new InvalidRequestError({ message: "model_not_found" }))
    expect(
      fallback({ cause, models: [current, next], refused: [model("opencode/big-pickle#max")] }),
    ).toBeUndefined()
    expect(
      fallback({
        cause,
        models: [current, spare, next],
        refused: [model("opencode/big-pickle#max")],
      }),
    ).toEqual(spare)
  })

  test("returns nothing when the session carries no fallback models", () => {
    const cause = failure(new InvalidRequestError({ message: "User location is not supported" }))
    expect(fallback({ cause, models: [] })).toBeUndefined()
  })

  test("skips the current model and every model that already refused", () => {
    const cause = failure(
      new QuotaExceededError({
        message: "Rate limit exceeded.",
        body: JSON.stringify({ error: { type: "FreeUsageLimitError" } }),
      }),
    )
    expect(fallback({ cause, models: [current, next], refused: [next] })).toBeUndefined()
    expect(fallback({ cause, models: [current, spare, next], refused: [next] })).toEqual(spare)
    expect(fallback({ cause, models: [next, spare], refused: [next] })).toEqual(
      Model.Ref.make({ providerID: Provider.ID.make("opencode"), id: Model.ID.make("minimax-free") }),
    )
  })
})

describe("mainSessionFallbackChain (G2-14)", () => {
  const info = (providerID: string, id: string) =>
    Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id))
  const chain = (input: {
    cause: AIError
    current: string
    catalog: ReadonlyArray<Model.Info>
  }) => mainSessionFallbackChain({ cause: input.cause, current: model(input.current), catalog: input.catalog })
  const asFailure = (cause: AIError) => failure(cause)
  const invalidRequest = new InvalidRequestError({ message: "model_not_found" })
  const auth = new AuthenticationError({ message: "Unauthorized" })
  // The B14 catalog: the planner's free provider, the Anymodel models, lix as
  // the second provider, and a dead Anymodel model that must never be picked.
  const catalog = [
    info("opencode", "crouton-alpha-free"),
    info("opencode", "minimax-free"),
    info("anymodel", "sonnet-5"),
    info("anymodel", "anymodel-coder"),
    info("anymodel", "anymodel-v4.1-flash"),
    info("lix", "lix-test-model"),
  ]

  test("a main session outside Anymodel falls back across providers", () => {
    expect(chain({ cause: asFailure(invalidRequest), current: "opencode/crouton-alpha-free", catalog })).toEqual([
      model("opencode/minimax-free"),
      model("anymodel/sonnet-5"),
      model("anymodel/anymodel-coder"),
      model("lix/lix-test-model"),
    ])
  })

  test("an authentication failure skips the whole current provider", () => {
    // A 401 means the provider is dead, not the model: no other model of the
    // same provider is tried, on either the current or the Anymodel side.
    expect(chain({ cause: asFailure(auth), current: "opencode/crouton-alpha-free", catalog })).toEqual([
      model("anymodel/sonnet-5"),
      model("anymodel/anymodel-coder"),
      model("lix/lix-test-model"),
    ])
    expect(chain({ cause: asFailure(auth), current: "anymodel/sonnet-5", catalog })).toEqual([
      model("lix/lix-test-model"),
      model("opencode/crouton-alpha-free"),
      model("opencode/minimax-free"),
    ])
  })

  test("a model-level refusal on Anymodel tries its other models first", () => {
    expect(chain({ cause: asFailure(invalidRequest), current: "anymodel/sonnet-5", catalog })).toEqual([
      model("anymodel/anymodel-coder"),
      model("lix/lix-test-model"),
      model("opencode/crouton-alpha-free"),
      model("opencode/minimax-free"),
    ])
  })

  test("never invents a provider: an empty catalog means no chain", () => {
    expect(chain({ cause: asFailure(invalidRequest), current: "opencode/crouton-alpha-free", catalog: [] })).toEqual(
      [],
    )
    // A verified Anymodel model that is not in the catalog is not offered either.
    expect(
      chain({
        cause: asFailure(invalidRequest),
        current: "opencode/crouton-alpha-free",
        catalog: [info("opencode", "crouton-alpha-free"), info("opencode", "minimax-free")],
      }),
    ).toEqual([model("opencode/minimax-free")])
  })

  test("lix is the second provider even when Anymodel has no key", () => {
    // Anymodel without a key has no models in the catalog (B14); lix is
    // still reachable as the fallback when it does have one.
    expect(
      chain({
        cause: asFailure(invalidRequest),
        current: "opencode/crouton-alpha-free",
        catalog: [info("opencode", "crouton-alpha-free"), info("lix", "lix-test-model")],
      }),
    ).toEqual([model("lix/lix-test-model")])
  })
})

// --- Runner integration: a real SessionRunnerLLM draining a real Session -------------------
// The harness mirrors session-runner.test.ts: the database, Session, projector and the runner
// are real; only the model catalog and the provider transport are replaced.

const integrationModel = (id: string) => LanguageModel.make({ id, provider: "fake", route: OpenAIChat.route })

const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) =>
    Effect.succeed(
      SessionRunnerModel.resolved(integrationModel(session.model?.id ?? "worker"), {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
    ),
})

const systemContext = Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) })
const instructionContext = Layer.mock(InstructionDiscovery.Service, {
  project: true,
  global: true,
  load: () => Effect.succeed(Instructions.empty),
})
const skillInstructions = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const referenceInstructions = Layer.mock(ReferenceInstructions.Service, {
  load: () => Effect.succeed(Instructions.empty),
})
const mcpInstructions = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const noteInstructions = Layer.mock(NoteInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const promptModels = Layer.mock(Model.Service, {
  get: () => Effect.undefined,
  all: () => Effect.succeed([]),
  // The live catalog the main-session chain is built from (G2-14): Anymodel
  // as the primary, lix as the second provider. The old empty catalog made
  // the main session unswitchable, which is exactly how B14 died.
  available: () =>
    Effect.succeed([
      Model.Info.default(Provider.ID.make("anymodel"), Model.ID.make("sonnet-5")),
      Model.Info.default(Provider.ID.make("anymodel"), Model.ID.make("anymodel-coder")),
      Model.Info.default(Provider.ID.make("lix"), Model.ID.make("lix-test-model")),
    ]),
  default: () => Effect.undefined,
  small: () => Effect.undefined,
})
const config = Config.testLayer()
const permission = permissionLayer()
const testLLM = TestLLM.layer({ fallback: [] })

const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  Snapshot.node.replace(Snapshot.noopLayer),
  LayerNodePlatform.llmClient.replace(TestLLM.clientLayer.pipe(Layer.provide(testLLM))),
  SessionRunnerModel.node.replace(models),
  Model.node.replace(promptModels),
  InstructionBuiltIns.node.replace(systemContext),
  InstructionDiscovery.node.replace(instructionContext),
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
  SkillInstructions.node.replace(skillInstructions),
  ReferenceInstructions.node.replace(referenceInstructions),
  McpInstructions.node.replace(mcpInstructions),
  NoteInstructions.node.replace(noteInstructions),
  Config.node.replace(config),
  Permission.node.replace(permission),
  PluginSupervisor.node.replace(Layer.empty),
  Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
])

const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    function drain(
      sessionID: Session.ID,
      force: boolean,
      continuation?: SessionRunner.Continuation,
    ): Effect.Effect<void, SessionRunner.RunError> {
      return sessionRunner.drain({ sessionID, force, continuation }).pipe(
        Effect.flatMap((result) =>
          result._tag === "Complete" ? Effect.void : drain(sessionID, false, result.continuation),
        ),
      )
    }
    const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => drain(sessionID, force),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      isActive: coordinator.isActive,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: (sessionID) => coordinator.interrupt(sessionID),
      awaitIdle: coordinator.awaitIdle,
    })
  }),
).pipe(Layer.provide(runnerLayer), Layer.orDie)

const integrationLayer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    Bus.node,
    SessionProjector.node,
    SessionStore.node,
    Agent.node,
    Model.node,
    PluginHooks.node,
    Tool.node,
    SessionRunnerModel.node,
    InstructionBuiltIns.node,
    InstructionDiscovery.node,
    SkillInstructions.node,
    ReferenceInstructions.node,
    Config.node,
    Snapshot.node,
    SessionRunnerLLM.node,
    Session.node,
  ]),
  [
    Bus.node.replace(Bus.configured({ persist: true })),
    LocationServiceMap.node.replace(promptLocationNode),
    LayerNodePlatform.llmClient.replace(TestLLM.clientLayer.pipe(Layer.provide(testLLM))),
    Permission.node.replace(permission),
    Model.node.replace(promptModels),
    SessionRunnerModel.node.replace(models),
    InstructionBuiltIns.node.replace(systemContext),
    InstructionDiscovery.node.replace(instructionContext),
    Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    SkillInstructions.node.replace(skillInstructions),
    ReferenceInstructions.node.replace(referenceInstructions),
    McpInstructions.node.replace(mcpInstructions),
    NoteInstructions.node.replace(noteInstructions),
    Config.node.replace(config),
    Snapshot.node.replace(Snapshot.noopLayer),
    PluginSupervisor.node.replace(Layer.empty),
    Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
    SessionExecution.node.replace(execution),
  ],
)

const it = testEffect(integrationLayer.pipe(Layer.provideMerge(testLLM)))

const workerSession = Session.ID.make("ses_fallback_worker")
const mainSession = Session.ID.make("ses_fallback_main")

const seed = (input: {
  readonly sessionID: Session.ID
  readonly model: string
  readonly models?: ReadonlyArray<Model.Ref>
}) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const model = yield* Model.Service
    const hooks = yield* PluginHooks.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.mode = "primary"
      }),
    )
    const pluginHost = host({
      agent: agentHost(agents),
      model: modelHost(model),
      provider: noProviders,
      session: { hook: (name, callback) => hooks.register("session", name, callback) },
    })
    yield* Effect.forEach(OptimizePlugin.Plugins, (plugin) => plugin.effect(pluginHost), { discard: true })
    yield* IdentityPlugin.Plugin.effect(pluginHost)
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: input.sessionID,
        project_id: Project.ID.global,
        slug: input.sessionID,
        directory: "/project",
        title: "test",
        version: "test",
        model: { id: input.model, providerID: "fake" },
        ...(input.models === undefined ? {} : { metadata: { [SessionModelsMetadataKey]: input.models } }),
      })
      .run()
      .pipe(Effect.orDie)
  })

// Runs one prompt to its end and reports the requested models in order plus the outcome.
const drainPrompt = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const llm = yield* TestLLM.Service
    const requests = llm.requests
    requests.length = 0
    yield* session.prompt({ sessionID, text, resume: false })
    const exit = yield* session.resume(sessionID).pipe(Effect.exit)
    const info = yield* session.get(sessionID)
    const messages = yield* session.context(sessionID)
    return {
      exit,
      model: info.model,
      requested: requests.map((request) => String(request.model.id)),
      messages,
    }
  })

const backup = Model.Ref.make({ providerID: Provider.ID.make("fake"), id: Model.ID.make("backup") })
// toSessionError rewrites a geo-blocked refusal into this actionable message; the drain
// tests below expect the rewritten text, not the raw provider message.
const invalidRequest = new AIError({ reason: new InvalidRequestError({ message: "User location is not supported" }) })
const geoBlockedMessage =
  "Google refused this network's location. Requests leave through a VPN or proxy exit that Google does not serve for this model; switch the exit to another country or connect directly, then retry."
const contentPolicy = new AIError({ reason: new ContentPolicyError({ message: "The request was blocked" }) })
const contextOverflow = new AIError({
  reason: new InvalidRequestError({ message: "Maximum context length is 128000 tokens", classification: "context-overflow" }),
})

describe("SessionRunnerLLM fallback while draining a session", () => {
  it.effect("moves a worker to its next model and finishes the step", () =>
    Effect.gen(function* () {
      yield* seed({ sessionID: workerSession, model: "worker", models: [backup] })
      const llm = yield* TestLLM.Service
      yield* llm.push(Stream.fail(invalidRequest), TestLLM.text("Recovered", "text-recovered"))

      const result = yield* drainPrompt(workerSession, "Do the work")

      expect(Exit.isSuccess(result.exit)).toBe(true)
      expect(result.requested).toEqual(["worker", "backup"])
      expect(result.model).toMatchObject({ providerID: "fake", id: "backup" })
      expect(result.messages.at(-1)).toMatchObject({
        type: "assistant",
        finish: "stop",
        content: [{ type: "text", text: "Recovered" }],
      })
    }),
  )

  it.effect("does not switch a worker to the same model with another variant", () =>
    Effect.gen(function* () {
      // The worker's list holds its own model under another variant first:
      // that is the same model (C-7), so the run must skip it for backup.
      const sameModelOtherVariant = Model.Ref.make({
        providerID: Provider.ID.make("fake"),
        id: Model.ID.make("worker"),
        variant: Model.VariantID.make("max"),
      })
      yield* seed({ sessionID: workerSession, model: "worker", models: [sameModelOtherVariant, backup] })
      const llm = yield* TestLLM.Service
      yield* llm.push(Stream.fail(invalidRequest), TestLLM.text("Recovered", "text-recovered"))

      const result = yield* drainPrompt(workerSession, "Do the work")

      expect(Exit.isSuccess(result.exit)).toBe(true)
      expect(result.requested).toEqual(["worker", "backup"])
      expect(result.model).toMatchObject({ providerID: "fake", id: "backup" })
    }),
  )

  it.effect("switches the main session to the catalog fallback on a non-Anymodel provider", () =>
    Effect.gen(function* () {
      // G2-14: the main session carries no operator list, but the live
      // catalog has Anymodel and lix — the B14 planner on its free provider
      // died exactly because this switch did not exist.
      yield* seed({ sessionID: mainSession, model: "worker" })
      const llm = yield* TestLLM.Service
      yield* llm.push(Stream.fail(invalidRequest), TestLLM.text("Recovered", "text-recovered"))

      const result = yield* drainPrompt(mainSession, "Do the work")

      expect(Exit.isSuccess(result.exit)).toBe(true)
      expect(result.requested).toEqual(["worker", "sonnet-5"])
      expect(result.model).toMatchObject({ providerID: "anymodel", id: "sonnet-5" })
      expect(result.messages.at(-1)).toMatchObject({
        type: "assistant",
        finish: "stop",
        content: [{ type: "text", text: "Recovered" }],
      })
    }),
  )

  it.effect("does not switch a worker on a content policy refusal", () =>
    Effect.gen(function* () {
      yield* seed({ sessionID: workerSession, model: "worker", models: [backup] })
      const llm = yield* TestLLM.Service
      yield* llm.push(Stream.fail(contentPolicy))

      const result = yield* drainPrompt(workerSession, "Do the work")

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.requested).toEqual(["worker"])
      expect(result.model).toMatchObject({ providerID: "fake", id: "worker" })
    }),
  )

  it.effect("does not switch a worker on a context overflow", () =>
    Effect.gen(function* () {
      yield* seed({ sessionID: workerSession, model: "worker", models: [backup] })
      const llm = yield* TestLLM.Service
      yield* llm.push(Stream.fail(contextOverflow))

      const result = yield* drainPrompt(workerSession, "Do the work")

      // Compaction may resend the same request; what matters is that no other model was tried.
      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.requested).not.toContain("backup")
      expect(result.model).toMatchObject({ providerID: "fake", id: "worker" })
    }),
  )

  it.effect("fails honestly once every fallback model has refused, without looping", () =>
    Effect.gen(function* () {
      yield* seed({ sessionID: workerSession, model: "worker", models: [backup] })
      const llm = yield* TestLLM.Service
      yield* llm.push(Stream.fail(invalidRequest), Stream.fail(invalidRequest))

      const result = yield* drainPrompt(workerSession, "Do the work")

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.requested).toEqual(["worker", "backup"])
      expect(result.model).toMatchObject({ providerID: "fake", id: "backup" })
      expect(result.messages.at(-1)).toMatchObject({
        type: "assistant",
        finish: "error",
        error: { type: "provider.invalid-request", message: geoBlockedMessage },
      })
    }),
  )

  it.effect("does not ping-pong back to a model that refused in an earlier step", () =>
    Effect.gen(function* () {
      yield* seed({ sessionID: workerSession, model: "worker", models: [backup] })
      const llm = yield* TestLLM.Service
      // Step 1: worker refuses, the run switches to backup, backup answers with a tool call
      // (an unknown tool fails, which still settles the step and starts step 2). Step 2:
      // backup refuses too — the run must fail honestly instead of switching back to worker.
      yield* llm.push(
        Stream.fail(invalidRequest),
        TestLLM.tool("call-unknown", "echo", { text: "hi" }),
        Stream.fail(invalidRequest),
        TestLLM.text("Done", "text-done"),
      )

      const result = yield* drainPrompt(workerSession, "Do the work")

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.requested).toEqual(["worker", "backup", "backup"])
      expect(result.model).toMatchObject({ providerID: "fake", id: "backup" })
    }),
  )
})
