import { expect } from "bun:test"
import { LanguageModel, LLMClient } from "@orchestra/ai"
import { RequestExecutor } from "@orchestra/ai/route"
import { OpenAIChat } from "@orchestra/ai/protocols"
import { TestLLM } from "@orchestra/ai/testing"
import { AISDK } from "@orchestra/core/aisdk"
import { Generate } from "@orchestra/core/generate"
import { Integration } from "@orchestra/core/integration"
import { ModelResolver } from "@orchestra/core/model-resolver"
import { ID, Info, Model, Ref } from "@orchestra/core/model"
import { Provider } from "@orchestra/core/provider"
import { zenRequiredToolNames } from "@orchestra/core/provider-request-compatibility"
import { Npm } from "@orchestra/util/npm"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "./lib/effect"

const selected = Info.make({
  ...Info.default(Provider.ID.make("test-provider"), ID.make("gemini")),
  package: Provider.aisdk("@ai-sdk/perplexity"),
})
const runtime = LanguageModel.make({ id: "gemini", provider: "test-provider", route: OpenAIChat.route })

const providers = Layer.mock(Provider.Service, {
  get: () => Effect.undefined,
})
const models = Layer.mock(Model.Service, {
  get: () => Effect.succeed(selected),
})
const integrations = Layer.mock(Integration.Service, {
  revision: () => 0,
  connection: {
    active: () => Effect.undefined,
    resolve: () => Effect.die("unused"),
    key: () => Effect.die("unused"),
    external: () => Effect.die("unused"),
    activate: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
  },
  oauth: {
    connect: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    complete: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  },
  command: {
    connect: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  },
})
const npm = Layer.mock(Npm.Service, {
  add: () => Effect.die("unused"),
  which: () => Effect.die("unused"),
})
const aisdk = Layer.mock(AISDK.Service, {
  hook: {
    sdk: () => Effect.die("unused"),
    language: () => Effect.die("unused"),
  },
  model: () => Effect.succeed(runtime),
})
const client = TestLLM.testLayer({ fallback: TestLLM.text("OK", "generate") })

const resolver = ModelResolver.layer.pipe(Layer.provide(Layer.mergeAll(providers, models, integrations, npm, aisdk)))
const it = testEffect(Generate.layer.pipe(Layer.provide(Layer.merge(resolver, client))))
const resolverIt = testEffect(resolver)

it.effect("loads dynamic AI SDK models", () =>
  Effect.gen(function* () {
    const generate = yield* Generate.Service
    const result = yield* generate.text({
      prompt: "Return exactly OK",
      model: Ref.make({ providerID: selected.providerID, id: selected.id }),
    })

    expect(result).toBe("OK")
  }),
)

resolverIt.effect("resolves dynamic models with their catalog metadata", () =>
  Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const result = yield* resolver.resolve(Ref.make({ providerID: selected.providerID, id: selected.id }))

    expect(result).toEqual({
      model: runtime,
      ref: Ref.make({ providerID: selected.providerID, id: selected.id }),
      capabilities: selected.capabilities,
      cost: selected.cost,
      limit: selected.limit,
    })
  }),
)

testEffect(Layer.empty).effect("attributes each stateless completion without creating a stored session", () =>
  Effect.gen(function* () {
    const sessions: string[] = []
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const session = request.headers["x-opencode-session"]
          if (!session)
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  error: { type: "MissingSessionID", message: "Session ID is required" },
                },
                { status: 400 },
              ),
            )
          sessions.push(session)
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              `data: ${JSON.stringify({
                id: "completion",
                object: "chat.completion.chunk",
                created: 1,
                model: "gemini",
                choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
              })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
          )
        }),
      ),
    )
    const native = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))
    yield* Effect.gen(function* () {
      const generate = yield* Generate.Service
      for (let index = 0; index < 2; index++) {
        expect(
          yield* generate.text({
            prompt: "Return exactly OK",
            model: Ref.make({ providerID: selected.providerID, id: selected.id }),
          }),
        ).toBe("OK")
      }
    }).pipe(Effect.provide(Generate.layer.pipe(Layer.provide(Layer.merge(resolver, native)))))
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toStartWith("ses_")
    expect(sessions[1]).not.toBe(sessions[0])
  }),
)

testEffect(Layer.empty).effect(
  "identifies the client and lists Zen's required tools without letting the model call them",
  () =>
    Effect.gen(function* () {
      const zen = Info.make({
        ...Info.default(Provider.ID.make("opencode"), ID.make("free-model")),
        package: Provider.aisdk("@ai-sdk/perplexity"),
      })
      const requests: Array<{ readonly headers: Record<string, string>; readonly body: unknown }> = []
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(request)
            requests.push({ headers: request.headers, body: yield* Effect.promise(() => web.json()) })
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                `data: ${JSON.stringify({
                  id: "completion",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "free-model",
                  choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
                })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              ),
            )
          }).pipe(Effect.orDie),
        ),
      )
      const zenResolver = ModelResolver.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            providers,
            Layer.mock(Model.Service, { get: () => Effect.succeed(zen) }),
            integrations,
            npm,
            Layer.mock(AISDK.Service, {
              hook: { sdk: () => Effect.die("unused"), language: () => Effect.die("unused") },
              model: () =>
                Effect.succeed(LanguageModel.make({ id: "free-model", provider: "opencode", route: OpenAIChat.route })),
            }),
          ),
        ),
      )
      const native = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))
      const text = yield* Effect.gen(function* () {
        const generate = yield* Generate.Service
        return yield* generate.text({
          prompt: "Return exactly OK",
          model: Ref.make({ providerID: zen.providerID, id: zen.id }),
        })
      }).pipe(Effect.provide(Generate.layer.pipe(Layer.provide(Layer.merge(zenResolver, native)))))

      expect(text).toBe("OK")
      expect(requests[0]?.headers["x-opencode-client"]).toBeDefined()
      expect(requests[0]?.headers["user-agent"]).toBeDefined()
      // Stateless generation has no tool list of its own, so it carries exactly the tool names
      // Zen's free-tier gate counts: schemas with no executor behind them and no tool choice.
      expect(requests[0]?.body).toMatchObject({
        tools: zenRequiredToolNames.map((name) => ({ function: { name } })),
        tool_choice: "none",
      })
    }),
)
