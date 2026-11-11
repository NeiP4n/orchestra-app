export * as SessionRunnerModel from "./model.js"

import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { LanguageModel } from "@orchestra/ai"
import { Model } from "@orchestra/schema/model"
import { Provider } from "@orchestra/schema/provider"
import { Context, Clock, Effect, Layer, Schema } from "effect"
import { ModelResolver } from "../../model-resolver.js"
import { SessionSchema } from "../schema.js"

export class ModelNotSelectedError extends Schema.TaggedError<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  { sessionID: SessionSchema.ID },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedError<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  { providerID: Provider.ID, modelID: Model.ID },
) {
  override get message() {
    if (this.providerID === "azure-cognitive-services")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use azure/${this.modelID} instead.`
    if (this.providerID === "google-vertex-anthropic")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use google-vertex/${this.modelID} instead.`
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}
export type Error = ModelNotSelectedError | ModelUnavailableError | ModelResolver.Error

// How long a session waits for a plugin to finish populating the catalog before it reports a
// requested model as unavailable. Provider plugins fetch their model list over the network.
const CATALOG_SETTLE_ATTEMPTS = 40
const CATALOG_SETTLE_INTERVAL = "250 millis"
// A model that never appeared is not re-awaited on every step: resolve runs on each step
// attempt, so a missing model used to sleep 10s per step. Remember a miss for this long, then
// look again once in case a plugin loaded the model late.
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000
export type Resolved = ModelResolver.Resolved

export interface Interface {
  /** Availability is sampled lazily for each explicitly selected model resolution. */
  readonly resolve: (
    session: SessionSchema.Info,
    available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
  ) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/SessionRunnerModel") {}

/** Builds a Resolved whose catalog identity mirrors the route model. Test or embedding seam. */
export const resolved = (
  model: LanguageModel,
  options: {
    readonly capabilities: Model.Capabilities
    readonly variant?: Model.VariantID
    readonly cost: Model.Info["cost"]
    readonly limit: Model.Info["limit"]
    readonly compaction?: Provider.Compaction
    readonly transport?: Provider.Transport
  },
): Resolved => ({
  model,
  ref: Model.Ref.make({
    id: Model.ID.make(model.id),
    providerID: Provider.ID.make(model.provider),
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  }),
  capabilities: options.capabilities,
  cost: options.cost,
  limit: options.limit,
  compaction: options.compaction,
  transport: options.transport,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    // Models already awaited once and still missing, by `providerID/modelID` to the time of
    // the miss. The catalog settles once per location; re-waiting on every step only burns
    // 10s per step on a model that is not coming back.
    const missingModels = new Map<string, number>()
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session, available) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        if (!session.model) {
          const resolved = yield* resolver.resolve()
          if (resolved) return resolved
          return yield* new ModelNotSelectedError({ sessionID: session.id })
        }

        let catalog = yield* available()
        const requested = session.model

        let selected = catalog.find(
          (model) => model.providerID === requested.providerID && model.id === requested.id,
        )
        // Provider plugins add their models after activation, and some of them finish that in a
        // background network refresh. A session started in that window used to fail with
        // "Model unavailable" for a model the catalog showed a moment later, so give the catalog
        // a short, bounded chance to include the requested model before rejecting it. That wait
        // runs once per missing model: resolve is called on every step, and a model that never
        // appears must not cost 10s on each of them.
        if (!selected) {
          const missKey = `${requested.providerID}/${requested.id}`
          const missedAt = missingModels.get(missKey)
          const now = yield* Clock.currentTimeMillis
          if (missedAt === undefined || now - missedAt >= NEGATIVE_CACHE_TTL_MS) {
            for (let attempt = 0; attempt < CATALOG_SETTLE_ATTEMPTS && !selected; attempt++) {
              yield* Effect.sleep(CATALOG_SETTLE_INTERVAL)
              catalog = yield* available()
              selected = catalog.find(
                (model) => model.providerID === requested.providerID && model.id === requested.id,
              )
            }
            if (selected) missingModels.delete(missKey)
            else missingModels.set(missKey, yield* Clock.currentTimeMillis)
          }
        }
        if (!selected) {
          // An explicit model choice is a route constraint, not permission to use another provider.
          // Keep the durable selection and surface the unavailable identity to the operator.
          return yield* new ModelUnavailableError({
            providerID: requested.providerID,
            modelID: requested.id,
          })
        }

        return yield* resolver.resolveModel(selected, requested.variant)
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [ModelResolver.node] })
