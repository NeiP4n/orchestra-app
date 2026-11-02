import { Provider } from "@orchestra/core/provider"
import { ProviderNotFoundError } from "@orchestra/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

// Provider settings can carry secrets: the Meta plugin stores its resolved
// apiKey in settings so the model route can use it server-side. That record
// is internal — clients set keys through the connect/credentials flows, so
// the HTTP boundary must never serialize a key. Strip it here only; the
// internal record is untouched, and this changes no HttpApi shape.
const withoutSecrets = (provider: Provider.Info): Provider.Info => {
  const { apiKey: _removed, ...settings } = provider.settings ?? {}

  return { ...provider, settings }
}

export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "provider.list",
        Effect.fn(function* () {
          const providers = yield* Provider.Service
          return yield* response(providers.available().map(withoutSecrets))
        }),
      )
      .handle(
        "provider.get",
        Effect.fn(function* (ctx) {
          const providers = yield* Provider.Service
          const provider = yield* providers.get(ctx.params.providerID)
          if (!provider)
            return yield* new ProviderNotFoundError({
              providerID: ctx.params.providerID,
              message: `Provider not found: ${ctx.params.providerID}`,
            })
          return yield* response(Effect.succeed(withoutSecrets(provider)))
        }),
      )
  }),
)
