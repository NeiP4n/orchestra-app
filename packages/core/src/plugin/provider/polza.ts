import { define } from "@orchestra/plugin/effect/plugin"
import type { Entry } from "@orchestra/schema/config"
import { Money } from "@orchestra/schema/money"
import { Duration, Effect, Schedule, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Config } from "../../config.js"
import { Model } from "../../model.js"
import type { PluginInternal } from "../internal.js"
import { foldSettings } from "./configured.js"

// Polza.ai keeps its model list on the server, so the catalog is discovered rather than shipped:
// `GET /models/catalog` reports every chat model with its context window, tool support and ruble
// prices. Prices are stored in the shared USD ledger the rest of Orchestra accounts in, converted
// at the ruble rate the provider settings carry (default `DEFAULT_EXCHANGE_RATE`).

const providerID = "polza"
const name = "Polza AI"
const defaultBaseURL = "https://polza.ai/api/v1"
const DEFAULT_EXCHANGE_RATE = 80
const REFRESH: Duration.Input = "10 minutes"
// 100 entries per page; the catalog has a few hundred chat models, so this is headroom, not a limit.
const MAX_PAGES = 20

const Pricing = Schema.Struct({
  currency: Schema.optional(Schema.String),
  prompt_per_million: Schema.optional(Schema.Unknown),
  completion_per_million: Schema.optional(Schema.Unknown),
  input_cache_read_per_million: Schema.optional(Schema.Unknown),
  input_cache_write_per_million: Schema.optional(Schema.Unknown),
})

const ModelEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  context_length: Schema.optional(Schema.NullOr(Schema.Number)),
  max_completion_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  endpoints: Schema.optional(Schema.Array(Schema.String)),
  architecture: Schema.optional(
    Schema.Struct({
      input_modalities: Schema.optional(Schema.Array(Schema.String)),
      output_modalities: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  capabilities: Schema.optional(
    Schema.Struct({
      tools: Schema.optional(Schema.Struct({ status: Schema.optional(Schema.String) })),
    }),
  ),
  pricing: Schema.optional(Pricing),
  top_provider: Schema.optional(
    Schema.Struct({
      pricing: Schema.optional(Pricing),
      context_length: Schema.optional(Schema.NullOr(Schema.Number)),
      max_completion_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
      supported_parameters: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

const Catalog = Schema.Struct({
  data: Schema.Array(ModelEntry),
  meta: Schema.optional(Schema.Struct({ totalPages: Schema.optional(Schema.Number) })),
})

type Discovered = {
  readonly id: string
  readonly name: string
  readonly context?: number
  readonly output?: number
  readonly tools: boolean
  readonly vision: boolean
  readonly cost: ReadonlyArray<(typeof Model.Cost)["Type"]>
}

export const PolzaPlugin = define({
  id: "orchestra.provider.polza",
  effect: Effect.fn(function* (ctx) {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const config = yield* Config.Service
    const lock = Semaphore.makeUnsafe(1)
    const source = { current: polzaSettings(yield* config.entries()) }
    const loaded = { models: [] as readonly Discovered[], hash: "[]" }

    yield* ctx.provider.transform((providers) => {
      if (loaded.models.length === 0) return
      providers.update(providerID, (provider) => {
        provider.name = name
        provider.activation = "enabled"
        provider.package = "@orchestra/ai/providers/polza"
        provider.settings = {
          ...source.current.settings,
        }
        provider.integrationID = undefined
      })
      for (const item of loaded.models) {
        providers.models.update(providerID, item.id, (model) => {
          model.modelID = Model.ID.make(item.id)
          model.name = item.name
          model.family = Model.Family.make(item.id.split("/")[0] ?? providerID)
          model.capabilities = {
            tools: item.tools,
            input: ["text", ...(item.vision ? ["image"] : [])],
            output: ["text"],
          }
          if (item.context !== undefined && item.context > 0) model.limit.context = item.context
          if (item.output !== undefined && item.output > 0) model.limit.output = item.output
          model.cost = [...item.cost]
        })
      }
    })

    const refresh = Effect.fn("PolzaPlugin.refresh")(function* () {
      const current = source.current
      // Without a Polza entry there is nothing to offer, and an unconfigured install must not reach
      // the network on its own. The catalog itself is public, so a keyless entry still lists models.
      if (!current.configured) return
      const models = yield* lock.withPermit(
        Effect.gen(function* () {
          const found: Discovered[] = []
          // The catalog is paginated at 100 entries; the chat filter keeps the catalog to the
          // models the chat protocol can run.
          for (let page = 1; page <= MAX_PAGES; page++) {
            const request = HttpClientRequest.get(
              `${current.baseURL}/models/catalog?type=chat&limit=100&page=${page}`,
            ).pipe(HttpClientRequest.acceptJson)
            const response = yield* http
              .execute(current.apiKey ? request.pipe(HttpClientRequest.bearerToken(current.apiKey)) : request)
              .pipe(Effect.timeout("20 seconds"))
            const body = yield* HttpClientResponse.schemaBodyJson(Catalog)(response)
            found.push(
              ...body.data.flatMap((item) => discoverModels(item, current.exchangeRate)),
            )
            const total = body.meta?.totalPages ?? 1
            if (page >= total || body.data.length === 0) break
          }
          return found.toSorted((a, b) => a.id.localeCompare(b.id))
        }),
      )
      const hash = JSON.stringify(models)
      if (hash === loaded.hash) return
      loaded.models = models
      loaded.hash = hash
      yield* Effect.logInfo("polza models discovered", { count: models.length })
      yield* ctx.provider.reload()
    })

    yield* refresh().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("polza model catalog refresh failed", { baseURL: source.current.baseURL, cause }),
      ),
      Effect.repeat(Schedule.spaced(REFRESH)),
      Effect.forkScoped,
    )

    const reload = Effect.fn("PolzaPlugin.reload")(function* () {
      const next = polzaSettings(yield* config.entries())
      if (
        next.baseURL === source.current.baseURL &&
        next.apiKey === source.current.apiKey &&
        next.exchangeRate === source.current.exchangeRate &&
        next.configured === source.current.configured
      )
        return
      source.current = next
      loaded.models = []
      loaded.hash = "[]"
      yield* ctx.provider.reload()
      yield* refresh().pipe(Effect.ignore)
    })

    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(reload),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)

export function polzaSettings(entries: readonly Entry[]) {
  const settings = foldSettings(entries, providerID, undefined) as
    | { apiKey?: unknown; baseURL?: unknown; exchangeRate?: unknown }
    | undefined
  const baseURL = (
    typeof settings?.baseURL === "string" ? settings.baseURL : defaultBaseURL
  ).replace(/\/+$/, "")
  const apiKey =
    typeof settings?.apiKey === "string" && settings.apiKey.length > 0
      ? settings.apiKey
      : process.env.POLZA_API_KEY
  const rate = typeof settings?.exchangeRate === "number" && settings.exchangeRate > 0
    ? settings.exchangeRate
    : DEFAULT_EXCHANGE_RATE
  return {
    baseURL,
    apiKey,
    exchangeRate: rate,
    configured: settings !== undefined || apiKey !== undefined,
    settings: settings ?? {},
  }
}

export function discoverModels(item: typeof ModelEntry.Type, exchangeRate: number): Discovered[] {
  if (!item.id) return []
  if (item.type !== undefined && item.type !== "chat") return []
  if (item.endpoints !== undefined && !item.endpoints.some((endpoint) => endpoint.includes("chat/completions")))
    return []
  const pricing = item.top_provider?.pricing ?? item.pricing
  const rubles = pricing?.currency?.toUpperCase() !== "USD"
  const perMillion = (value: unknown) => {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
    if (!Number.isFinite(parsed) || parsed < 0) return Money.USDPerMillionTokens.zero
    const usd = rubles ? parsed / exchangeRate : parsed
    return Money.USDPerMillionTokens.make(usd)
  }
  const tools =
    item.top_provider?.supported_parameters?.includes("tools") ??
    (item.capabilities?.tools?.status !== undefined && item.capabilities.tools.status !== "unsupported")
  return [
    {
      id: item.id,
      name: item.name || item.id,
      context: item.context_length ?? item.top_provider?.context_length ?? undefined,
      output: item.max_completion_tokens ?? item.top_provider?.max_completion_tokens ?? undefined,
      tools,
      vision: item.architecture?.input_modalities?.includes("image") ?? false,
      cost: [
        {
          input: perMillion(pricing?.prompt_per_million),
          output: perMillion(pricing?.completion_per_million),
          cache: {
            read: perMillion(pricing?.input_cache_read_per_million),
            write: perMillion(pricing?.input_cache_write_per_million),
          },
        },
      ],
    },
  ]
}
