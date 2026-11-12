import { Effect, Stream } from "effect"
import { define } from "@orchestra/plugin/effect/plugin"
import { Bus } from "../../bus.js"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import { KLINCH_BASE_URL, KLINCH_PROVIDER_ID } from "../../session/runner/error-taxonomy.js"
import type { PluginInternal } from "../internal.js"

const providerID = Provider.ID.make(KLINCH_PROVIDER_ID)
const integrationID = Integration.ID.make(KLINCH_PROVIDER_ID)

// Arch3 №4: klinch (https://api.klinch.cloud/v1) is a seeded provider next to
// lix and Anymodel.
// The provider is seeded here so the integration works without extra
// configuration, but the key lives only in the credential store (integration
// "klinch"): with no key the provider is registered but never available (see
// `Provider.snapshot`), so nothing advertises it as working and startup
// never depends on it. Models come from the live /models listing, through
// the same discovery the society preflight uses — no second liveness
// check. The stored key reaches requests automatically: `ModelResolver`
// resolves the credential by the provider's integrationID and hands it to
// the OpenAI-compatible package as `apiKey`.
export const KlinchPlugin = define({
  id: "orchestra.provider.klinch",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const providers = yield* Provider.Service

    yield* ctx.integration.transform((editor) => {
      // The registry names unknown integrations after their ID; show the product name instead.
      editor.update(KLINCH_PROVIDER_ID, (integration) => {
        integration.name = "Klinch"
      })
      editor.method.update({ integrationID: KLINCH_PROVIDER_ID, method: { type: "key", label: "Manually enter API Key" } })
    })

    const sync = Effect.fn("KlinchPlugin.sync")(function* (trigger: "startup" | "credential-updated" | "credential-switched") {
      const log = (state: string, details: Record<string, string | number> = {}) =>
        Effect.logInfo("Klinch model discovery", { providerID, trigger, state, ...details })
      yield* log("checking-connection")
      // Seed the provider so the integration works without extra configuration.
      yield* providers.transform((editor) => {
        if (!editor.get(providerID))
          editor.add({
            info: {
              ...Provider.Info.empty(providerID),
              name: "Klinch",
              package: "@orchestra/ai/providers/openai-compatible",
              integrationID,
            },
            models: [],
          })
        editor.update(providerID, (provider) => {
          provider.package = "@orchestra/ai/providers/openai-compatible"
          provider.settings = { baseURL: KLINCH_BASE_URL, provider: KLINCH_PROVIDER_ID, apiKey: "" }
          provider.integrationID = integrationID
        })
      })
      // No stored key, no network: without a connection there is nothing to
      // discover, and the provider stays registered-but-unavailable.
      const connection = yield* ctx.integration.connection
        .active(KLINCH_PROVIDER_ID)
        .pipe(Effect.orElseSucceed(() => undefined))
      if (!connection) {
        yield* log("not-attempted", { reason: "no-active-connection" })
        return
      }
      yield* log("started")
      const discovered = yield* ctx.provider
        .discover({ baseURL: KLINCH_BASE_URL, providerID })
        .pipe(
          Effect.catchCause(() => log("failed", { reason: "internal-error" }).pipe(Effect.as(undefined))),
          Effect.onInterrupt(() => log("interrupted")),
        )
      if (!discovered) return
      if (!discovered.ok) {
        // Only taxonomy and HTTP status are safe: never log the key, headers,
        // raw response body, error message or cause supplied by an endpoint.
        yield* log("failed", {
          reason: discovered.error?.kind ?? "unknown",
          ...(discovered.error?.status === undefined ? {} : { httpStatus: discovered.error.status }),
        })
        // A dead or removed key must not leave its models advertised; a
        // transient failure keeps the last good inventory.
        if (discovered.error?.kind !== "auth") return
        yield* providers.transform((editor) => {
          editor.models.set(providerID, [])
        })
        return
      }
      yield* log("succeeded", { modelCount: discovered.models.length })
      yield* providers.transform((editor) => {
        editor.models.set(
          providerID,
          discovered.models.map((entry) => {
            const info = Model.Info.default(providerID, Model.ID.make(entry.id))
            return entry.name === undefined || entry.name === entry.id ? info : { ...info, name: entry.name }
          }),
        )
      })
    })

    const refresh = (trigger: "startup" | "credential-updated" | "credential-switched") =>
      sync(trigger).pipe(Effect.andThen(ctx.provider.reload()))
    yield* bus.subscribe(Credential.Event.Switched).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(() => refresh("credential-switched")),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* bus.subscribe(Credential.Event.Updated).pipe(
      Stream.runForEach(() => refresh("credential-updated")),
      Effect.forkScoped({ startImmediately: true }),
    )
    // Eager on startup: with a stored key the models are in the catalog
    // before the first session needs them; without one sync does no network.
    yield* refresh("startup")
  }),
} satisfies PluginInternal.InternalPlugin)
