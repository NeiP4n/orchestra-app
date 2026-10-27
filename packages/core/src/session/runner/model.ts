export * as SessionRunnerModel from "./model.js"

import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { LanguageModel } from "@orchestra/ai"
import { Model } from "@orchestra/schema/model"
import { Provider } from "@orchestra/schema/provider"
import { Context, Effect, Layer, Schema } from "effect"
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

        // Migrate the model reference before looking it up. Older OpenCode++ builds could
        // persist this removed Zen free-tier model even after it disappeared from the catalog.
        // Never send that stale reference to the provider and never hardcode a replacement model.
        const legacyMuse = requested.providerID === "opencode" && requested.id === "muse-spark-1.3-contributor-free"
        if (legacyMuse) {
          const replacement =
            catalog.find((model) => model.providerID === requested.providerID && model.id !== requested.id) ??
            catalog.find((model) => model.id !== requested.id)
          if (replacement) return yield* resolver.resolveModel(replacement, undefined)
          return yield* new ModelUnavailableError({
            providerID: requested.providerID,
            modelID: requested.id,
          })
        }

        let selected = catalog.find(
          (model) => model.providerID === requested.providerID && model.id === requested.id,
        )
        // Provider plugins add their models after activation, and some of them finish that in a
        // background network refresh. A session started in that window used to fail with
        // "Model unavailable" for a model the catalog showed a moment later, so give the catalog
        // a short, bounded chance to include the requested model before rejecting it.
        if (!selected) {
          for (let attempt = 0; attempt < CATALOG_SETTLE_ATTEMPTS && !selected; attempt++) {
            yield* Effect.sleep(CATALOG_SETTLE_INTERVAL)
            catalog = yield* available()
            selected = catalog.find(
              (model) => model.providerID === requested.providerID && model.id === requested.id,
            )
          }
        }
        if (!selected) {
          // A provider that disappeared with its plugin (a removed third-party provider, say) leaves
          // resumable sessions pointing at a model that no longer exists. Those continue on the
          // configured default model instead of dying on a stale reference; a model missing from a
          // provider that still exists stays an explicit error.
          const providerExists = catalog.some((model) => model.providerID === requested.providerID)
          if (!providerExists) {
            const fallback = yield* resolver.resolve()
            if (fallback) {
              yield* Effect.logInfo("session model provider is gone; continuing on the default model", {
                sessionID: session.id,
                providerID: requested.providerID,
                modelID: requested.id,
                fallbackProviderID: fallback.ref.providerID,
                fallbackModelID: fallback.ref.id,
              })
              return fallback
            }
          }
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
