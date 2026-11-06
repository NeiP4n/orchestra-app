export * as SocietyPreflight from "./society-preflight.js"

import { Effect, Option } from "effect"
import { Credential } from "./credential.js"
import { Model } from "./model.js"
import { Provider } from "./provider.js"
import { discoverModels } from "./provider-discovery.js"
import { Society } from "./society.js"
import { Integration } from "@orchestra/schema/integration"

// G2-1 (N-01, R-7-preflight): the provider preflight that runs before a
// Society is created and before a stalled one is resumed. B14 founded a
// Society with no Anymodel key at all, woke its planner, and only learned
// about it from the first model's 401 — twice, deterministically. This gate
// refuses (or stays quiet) BEFORE anything is created or woken, with a
// message that names the fix instead of a 401 in a log.
//
// The check is split in two so the decision is unit-testable without any
// layer: `checkSocietyProvider` takes plain inputs plus an injectable fetch,
// `checkLive` reads the three services out of the ambient context (all
// optional — a layer without them gets `skipped`, never a false failure).

export const ANYMODEL_PROVIDER_ID = "anymodel"

export type PreflightFailureReason = "no-credential" | "no-provider" | "auth" | "unreachable" | "no-planner-model"

export type PreflightResult =
  | {
      readonly status: "ok"
      readonly providerID: string
      readonly baseURL: string
      /** Model ids the provider actually serves right now. */
      readonly models: ReadonlyArray<string>
      readonly plannerModel: { readonly providerID: string; readonly modelID: string }
      /** Non-fatal notes: e.g. the planner runs on another provider. */
      readonly warnings: ReadonlyArray<string>
    }
  | {
      readonly status: "failed"
      readonly reason: PreflightFailureReason
      /** What is wrong, in one line. */
      readonly message: string
      /** What the operator does about it. */
      readonly action: string
    }
  | {
      readonly status: "skipped"
      readonly reason: string
    }

export interface PreflightInput {
  /** The stored Anymodel key, if the credential store has a non-empty one. */
  readonly credentialKey?: string
  /** A key carried in the provider settings (config `{env:}` path), if any. */
  readonly settingsKey?: string
  /** The Anymodel endpoint, from the provider settings. */
  readonly baseURL?: string
  readonly providerDisabled?: boolean
  /** The model the planner would run on; the Society fallback when unset. */
  readonly plannerModel?: { readonly providerID: string; readonly modelID: string }
  /** Model ids the catalog offers for the planner's provider (non-Anymodel planner only). */
  readonly catalogModelIDs?: ReadonlyArray<string>
  readonly fetchFn?: (url: string, init: RequestInit) => Promise<Response>
}

const failed = (reason: PreflightFailureReason, message: string, action: string): PreflightResult => ({
  status: "failed",
  reason,
  message,
  action,
})

/**
 * Pure provider check: a stored key, a configured endpoint, a live `/models`
 * answer, and the planner's model actually served. Never throws: every
 * outcome — including a dead network — is a value.
 */
export const checkSocietyProvider = Effect.fn("SocietyPreflight.check")(function* (input: PreflightInput) {
  const key = input.credentialKey?.trim() ? input.credentialKey.trim() : input.settingsKey?.trim()
  if (!key)
    return failed(
      "no-credential",
      "No Anymodel API key is stored: the credential store has no key for integration \"anymodel\" and the provider settings carry none either.",
      "Add the Anymodel key in Settings → Credentials (integration \"anymodel\"), or set it in orchestra.json as \"{env:ANYMODEL_API_KEY}\" with the variable exported.",
    )
  if (input.providerDisabled)
    return failed(
      "no-provider",
      "The Anymodel provider is disabled.",
      "Enable the Anymodel provider in Settings → Providers, or remove the provider override that disables it.",
    )
  const baseURL = input.baseURL?.trim()
  if (!baseURL)
    return failed(
      "no-provider",
      "The Anymodel provider is not configured: no base URL is set.",
      "Add the Anymodel provider in Settings → Providers (or orchestra.json \"providers\") with base URL https://anymodel.ghostly.su/v1.",
    )
  const result = yield* Effect.promise(() => discoverModels({ baseURL, apiKey: key }, input.fetchFn ?? fetch))
  if (!result.ok) {
    if (result.error.kind === "auth")
      return failed(
        "auth",
        `The Anymodel key was rejected by ${baseURL} (${result.error.message}).`,
        "Replace the stored Anymodel key in Settings → Credentials: the saved one is dead or revoked.",
      )
    if (result.error.kind === "invalid-url")
      return failed(
        "no-provider",
        `The Anymodel base URL is not usable: ${result.error.message}.`,
        "Fix the Anymodel provider's base URL in Settings → Providers (expected https://anymodel.ghostly.su/v1).",
      )
    return failed(
      "unreachable",
      `The Anymodel endpoint did not answer /models (${result.error.kind}: ${result.error.message}).`,
      "Check the network and that the Anymodel endpoint is up, then retry. Nothing was created.",
    )
  }
  const models = result.models.map((model) => model.id)
  const planner = input.plannerModel ?? { providerID: ANYMODEL_PROVIDER_ID, modelID: Society.FALLBACK_MODEL_ID }
  const warnings: Array<string> = []
  if (planner.providerID === ANYMODEL_PROVIDER_ID) {
    const served = models.some((id) => id.toLowerCase() === planner.modelID.toLowerCase())
    if (!served)
      return failed(
        "no-planner-model",
        `The planner model "${planner.modelID}" is not served by Anymodel right now (live /models list has ${models.length} models).`,
        `Set the planner's default model to one Anymodel serves (for example "${Society.FALLBACK_MODEL_ID}"), or wait for the provider to list "${planner.modelID}" again.`,
      )
  } else {
    warnings.push(
      `The planner model "${planner.providerID}/${planner.modelID}" is not on Anymodel: the Society's workers run on Anymodel, the planner runs elsewhere.`,
    )
    const inCatalog = (input.catalogModelIDs ?? []).some((id) => id.toLowerCase() === planner.modelID.toLowerCase())
    if (!inCatalog)
      return failed(
        "no-planner-model",
        `The planner model "${planner.providerID}/${planner.modelID}" is not in the model catalog.`,
        "Pick a default model the account actually has, then retry.",
      )
  }
  return {
    status: "ok",
    providerID: ANYMODEL_PROVIDER_ID,
    baseURL,
    models,
    plannerModel: planner,
    warnings,
  } satisfies PreflightResult
})

const stringSetting = (settings: Provider.Settings | undefined, name: string): string | undefined => {
  const value = (settings as Readonly<Record<string, unknown>> | undefined)?.[name]
  return typeof value === "string" ? value : undefined
}

/**
 * The live preflight: resolves the key (credential store first, provider
 * settings second — the two paths N-01 names), the endpoint, and the planner
 * model from the ambient services. When the Credential and Provider services
 * are both absent from the layer (unit-test layers), the check is `skipped`
 * instead of failed: a layer that cannot verify must not veto creation.
 * Every service read is guarded, so a preflight can never throw.
 */
export const checkLive = Effect.fn("SocietyPreflight.checkLive")(function* (input?: {
  readonly fetchFn?: (url: string, init: RequestInit) => Promise<Response>
}) {
  const credentials = yield* Effect.serviceOption(Credential.Service)
  const providers = yield* Effect.serviceOption(Provider.Service)
  const models = yield* Effect.serviceOption(Model.Service)
  if (Option.isNone(credentials) && Option.isNone(providers))
    return {
      status: "skipped",
      reason: "Credential and Provider services are not in this layer, so the Anymodel key and endpoint cannot be verified here.",
    } satisfies PreflightResult
  // A stored key is read before the Provider check: a missing key is
  // definitive evidence (the provider is dead), not a missing endpoint.
  // Only a stored key whose endpoint cannot be determined is unverifiable
  // and skips — otherwise the G2-1 gates (refuse creation, stay quiet on
  // resume) silently open whenever the Provider service is absent.
  const stored = Option.isNone(credentials)
    ? []
    : yield* credentials.value
        .list(Integration.ID.make(ANYMODEL_PROVIDER_ID))
        .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<Credential.Info>)))
  // Credential listings order each integration's selected credential last,
  // so the selected key is the last key credential in the list.
  const keyEntry = [...stored].reverse().find((item) => item.value.type === "key")
  const credentialKey =
    keyEntry?.value.type === "key" && keyEntry.value.key.trim() !== "" ? keyEntry.value.key : undefined
  // The endpoint comes from the Provider service alone: when it is absent
  // from this layer (the Federation context does not provide it), the base
  // URL cannot be determined at all — and a missing base URL must not be
  // reported as an unconfigured provider. Skip instead of failing, but only
  // when a key is stored: with no key the pure check below fails with
  // "No Anymodel API key", which is the correct definitive answer.
  if (Option.isNone(providers) && credentialKey !== undefined)
    return {
      status: "skipped",
      reason: "Provider service is not in this layer, so the Anymodel endpoint cannot be verified here.",
    } satisfies PreflightResult
  const info = Option.isNone(providers)
    ? undefined
    : yield* providers.value
        .get(Provider.ID.make(ANYMODEL_PROVIDER_ID))
        .pipe(Effect.catch(() => Effect.succeed(undefined as Provider.Info | undefined)))
  const settingsKey = stringSetting(info?.settings, "apiKey")
  const defaultModel = Option.isNone(models)
    ? undefined
    : yield* models.value.default().pipe(Effect.catch(() => Effect.succeed(undefined as Model.Info | undefined)))
  const catalogModelIDs = Option.isNone(models)
    ? undefined
    : yield* models.value
        .available()
        .pipe(
          Effect.map((available) =>
            available
              .filter((model) => defaultModel !== undefined && model.providerID === defaultModel.providerID)
              .map((model) => model.id),
          ),
          Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
        )
  return yield* checkSocietyProvider({
    ...(credentialKey !== undefined ? { credentialKey } : {}),
    ...(settingsKey !== undefined ? { settingsKey } : {}),
    ...(stringSetting(info?.settings, "baseURL") !== undefined ? { baseURL: stringSetting(info?.settings, "baseURL") } : {}),
    ...(info?.activation === "disabled" ? { providerDisabled: true } : {}),
    ...(defaultModel !== undefined
      ? { plannerModel: { providerID: defaultModel.providerID, modelID: defaultModel.id } }
      : {}),
    ...(catalogModelIDs !== undefined ? { catalogModelIDs } : {}),
    ...(input?.fetchFn !== undefined ? { fetchFn: input.fetchFn } : {}),
  })
})
