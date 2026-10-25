import { Model } from "@orchestra/core/model"
import { Plugin } from "@orchestra/core/plugin"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "model.list",
        Effect.fn(function* () {
          // Providers are registered by plugin activation, so a request that lands during
          // startup used to answer with an empty catalog and the client showed no models.
          yield* Plugin.awaitActivation
          const models = yield* Model.Service
          return yield* response(models.available())
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          yield* Plugin.awaitActivation
          const models = yield* Model.Service
          return yield* response(models.default())
        }),
      )
  }),
)
