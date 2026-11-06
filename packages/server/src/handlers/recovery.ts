import { Plugin } from "@orchestra/core/plugin"
import { Recovery } from "@orchestra/core/recovery"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const RecoveryHandler = HttpApiBuilder.group(Api, "server.recovery", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "recovery.models",
        Effect.fn(function* () {
          // Providers are registered by plugin activation, so a request that lands during
          // startup used to answer with an empty catalog.
          yield* Plugin.awaitActivation
          const recovery = yield* Recovery.Service
          return yield* response(recovery.listModels())
        }),
      )
      .handle(
        "recovery.chat",
        Effect.fn(function* (ctx) {
          yield* Plugin.awaitActivation
          const recovery = yield* Recovery.Service
          return yield* recovery.chat({ model: ctx.payload.model, messages: ctx.payload.messages })
        }),
      )
  }),
)
