import { describe, expect } from "bun:test"
import { LanguageModel } from "@orchestra/ai"
import { OpenAIChat } from "@orchestra/ai/protocols"
import { Model } from "@orchestra/schema/model"
import { Provider } from "@orchestra/schema/provider"
import { Effect, Layer, Ref } from "effect"
import { ModelResolver } from "../src/model-resolver"
import { SessionRunnerModel } from "../src/session/runner/model"
import { SessionSchema } from "../src/session/schema"
import { it } from "./lib/effect"

const info = (id: string): Model.Info => Model.Info.default(Provider.ID.make("google"), Model.ID.make(id))

const session = (modelID: string) =>
  ({
    id: SessionSchema.ID.make("ses_test"),
    model: Model.Ref.make({ providerID: Provider.ID.make("google"), id: Model.ID.make(modelID) }),
  }) as unknown as SessionSchema.Info

/** Records which catalog model the resolver was asked for, without loading a provider package. */
const layer = (selected: Ref.Ref<string | undefined>) =>
  SessionRunnerModel.layer.pipe(
    Layer.provide(
      Layer.succeed(ModelResolver.Service, {
        resolve: () => Effect.succeed(undefined),
        resolveModel: (model) =>
          Ref.set(selected, model.id).pipe(
            Effect.as(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: model.id, provider: model.providerID, route: OpenAIChat.route }),
                {
                  capabilities: model.capabilities,
                  cost: model.cost,
                  limit: model.limit,
                },
              ),
            ),
          ),
      }),
    ),
  )

describe("SessionRunnerModel.resolve", () => {
  it.live("waits for a plugin catalog that finishes after the session starts", () => {
    return Effect.gen(function* () {
      const selected = yield* Ref.make<string | undefined>(undefined)
      return yield* Effect.gen(function* () {
      const service = yield* SessionRunnerModel.Service
      const polls = yield* Ref.make(0)
      const available = () =>
        Ref.updateAndGet(polls, (value) => value + 1).pipe(
          Effect.map((count) => (count < 3 ? [] : [info("late")])),
        )
      const result = yield* service.resolve(session("late"), available)
      return { id: result.ref.id, polls: yield* Ref.get(polls), selected: yield* Ref.get(selected) }
      }).pipe(Effect.provide(layer(selected)))
    }).pipe(
      Effect.map(({ id, polls, selected }) => {
        expect(selected).toBe("late")
        expect(String(id)).toBe("late")
        // The first read misses, later reads find it: the resolver must not reject on the first miss.
        expect(polls).toBeGreaterThan(1)
      }),
    )
  })

  it.live("reports a model that never appears as unavailable", () => {
    return Effect.gen(function* () {
      const selected = yield* Ref.make<string | undefined>(undefined)
      return yield* Effect.gen(function* () {
        const service = yield* SessionRunnerModel.Service
        return yield* service.resolve(session("missing"), () => Effect.succeed([info("other")])).pipe(Effect.flip)
      }).pipe(Effect.provide(layer(selected)))
    }).pipe(
      Effect.map((failure) => {
        expect(failure._tag).toBe("SessionRunnerModel.ModelUnavailableError")
        expect(failure.message).toContain("google/missing")
      }),
    )
  }, 15_000)
})
