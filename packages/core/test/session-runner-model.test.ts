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
const layer = (selected: Ref.Ref<string | undefined>, fallback?: SessionRunnerModel.Resolved) =>
  SessionRunnerModel.layer.pipe(
    Layer.provide(
      Layer.succeed(ModelResolver.Service, {
        resolve: () => Ref.set(selected, "UNREQUESTED_DEFAULT").pipe(Effect.as(fallback)),
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

  it.live("fails fast on a repeated resolve of a model that never appears", () => {
    return Effect.gen(function* () {
      const selected = yield* Ref.make<string | undefined>(undefined)
      return yield* Effect.gen(function* () {
        const service = yield* SessionRunnerModel.Service
        const missing = () =>
          service.resolve(session("missing"), () => Effect.succeed([info("other")])).pipe(Effect.flip)
        yield* missing()
        const started = Date.now()
        const failure = yield* missing()
        return { failure, elapsed: Date.now() - started }
      }).pipe(Effect.provide(layer(selected)))
    }).pipe(
      Effect.map(({ failure, elapsed }) => {
        expect(failure._tag).toBe("SessionRunnerModel.ModelUnavailableError")
        // The first resolve waits out the catalog settle (10s); the second must not re-wait it:
        // resolve runs on every step, and a missing model used to sleep 10s per step. The 60s
        // timeout is headroom for timer drift on a loaded machine, not for the second resolve:
        // it performs no sleeps at all, so it stays fast even when the first one drifts.
        expect(elapsed).toBeLessThan(5_000)
      }),
    )
  }, 60_000)
})

for (const requested of [
  { providerID: "removed-provider", id: "chosen-model" },
  { providerID: "opencode", id: "muse-spark-1.3-contributor-free" },
]) {
  it.live(`never silently replaces explicit missing ${requested.providerID}/${requested.id} with a configured default`, () =>
    Effect.gen(function* () {
      const selected = yield* Ref.make<string | undefined>(undefined)
      const other = info("other")
      const fallback = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "iceman-free", provider: "opencode", route: OpenAIChat.route }),
        { capabilities: other.capabilities, cost: other.cost, limit: other.limit },
      )
      const value = { ...session(requested.id), model: Model.Ref.make({ providerID: Provider.ID.make(requested.providerID), id: Model.ID.make(requested.id) }) }
      const failure = yield* Effect.gen(function* () {
        const models = yield* SessionRunnerModel.Service
        return yield* models.resolve(value, () => Effect.succeed([other])).pipe(Effect.flip)
      }).pipe(Effect.provide(layer(selected, fallback)))
      expect(failure).toMatchObject({ _tag: "SessionRunnerModel.ModelUnavailableError", providerID: requested.providerID, modelID: requested.id })
      expect(yield* Ref.get(selected)).toBeUndefined()
    }),
    15_000,
  )
}
