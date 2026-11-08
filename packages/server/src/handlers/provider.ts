import { Provider } from "@orchestra/core/provider"
import { Plugin } from "@orchestra/core/plugin"
import { Credential } from "@orchestra/core/credential"
import { discoverModels, reachable } from "@orchestra/core/provider-discovery"
import { Integration } from "@orchestra/schema/integration"
import { ProviderNotFoundError } from "@orchestra/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { requireLocationDirectory, response } from "../location"

// Provider settings can carry secrets: the Meta plugin stores its resolved
// apiKey in settings so the model route can use it server-side. That record
// is internal — clients set keys through the connect/credentials flows, so
// the HTTP boundary must never serialize a key. Strip it here only; the
// internal record is untouched, and this changes no HttpApi shape.
const withoutSecrets = (provider: Provider.Info): Provider.Info => {
  const { apiKey: _removed, ...settings } = provider.settings ?? {}

  return { ...provider, settings }
}

// Provider reads wait for plugin activation so the first call does not answer an empty catalog, but
// not without limit: a plugin that is slow to load must not hold a read, so after this long the
// read answers from the current snapshot.
const ACTIVATION_WAIT = "1 second"
const awaitActivationBriefly = Plugin.awaitActivation.pipe(Effect.timeoutOption(ACTIVATION_WAIT), Effect.asVoid)

export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "provider.list",
        Effect.fn(function* () {
          yield* requireLocationDirectory()
          // G2-6 (N2): providers are registered by plugin activation, like
          // models — without awaiting it this answered [] on the first call
          // while /api/model already showed the activated catalog. The wait is bounded.
          yield* awaitActivationBriefly
          const providers = yield* Provider.Service
          // available() returns an Effect of the provider list, not the list
          // itself: yield it before mapping. Calling .map on the Effect was
          // the defect behind every GET /api/provider returning 500
          // ("providers.available().map is not a function").
          const available = yield* providers.available()
          return yield* response(Effect.succeed(available.map(withoutSecrets)))
        }),
      )
      .handle(
        "provider.get",
        Effect.fn(function* (ctx) {
          yield* requireLocationDirectory()
          yield* awaitActivationBriefly
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
      .handle(
        "provider.discover",
        Effect.fn(function* (ctx) {
          const payload = ctx.payload
          let apiKey = payload.apiKey
          // No key in the request: resolve the endpoint's stored credential
          // here, server-side. The key is used for this call only and is
          // never part of the response.
          if (!apiKey && payload.providerID) {
            const credentials = yield* Credential.Service
            const stored = yield* credentials.list(Integration.ID.make(payload.providerID))
            // Credential listings order each integration's selected credential
            // last, so the selected key is the last key credential in the list.
            const key = [...stored].reverse().find((item) => item.value.type === "key")
            if (key?.value.type === "key") apiKey = key.value.key
          }
          const result = yield* Effect.promise(() =>
            discoverModels({ baseURL: payload.baseURL, apiKey, headers: payload.headers }),
          )
          return {
            ok: result.ok,
            reachable: reachable(result),
            models: result.ok ? result.models : [],
            ...(result.ok ? { latencyMs: result.latencyMs } : {}),
            ...(result.ok
              ? {}
              : {
                  error: {
                    kind: result.error.kind,
                    message: result.error.message,
                    ...("status" in result.error ? { status: result.error.status } : {}),
                  },
                }),
          }
        }),
      )
  }),
)
