import { define } from "@orchestra/plugin/effect/plugin"
import type { Entry } from "@orchestra/schema/config"
import { Effect, Stream } from "effect"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"
import { foldSettings } from "./configured.js"

// Meta (Muse Spark) provider plugin.
//
// Why a key, not an OAuth sign-in: Meta's own Authentication and billing
// page (https://dev.meta.ai/docs/muse-code/auth) documents no public OAuth
// endpoints, client ID, or device-code URL for a third-party app, and says
// the browser sign-in credential "only Muse Code can use" — "If you build
// your own app or want to call the Model API from another tool, use an API
// key." So this plugin registers exactly the path Meta prescribes for an
// app: a Model API key (META_API_KEY, falling back to MODEL_API_KEY, the
// name the Model API docs use), entered in the connector or from the
// environment. Once connected, Muse Spark models appear in Orchestra's
// model picker and can be called from any session, working alongside
// every other provider's models in the same workspace.
const providerID = Provider.ID.make("meta")
const integrationID = Integration.ID.make("meta")
const name = "Meta (Muse Spark)"
const defaultBaseURL = "https://api.meta.ai/v1"
const packageName = "@orchestra/ai/providers/meta/responses"

const models: ReadonlyArray<Model.Info> = [
  {
    ...Model.Info.default(providerID, Model.ID.make("muse-spark-1.3")),
    name: "Muse Spark 1.3",
    package: packageName,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  {
    ...Model.Info.default(providerID, Model.ID.make("muse-spark-1.3-contributor")),
    name: "Muse Spark 1.3 (Contributor)",
    package: packageName,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  {
    ...Model.Info.default(providerID, Model.ID.make("muse-spark-1.2")),
    name: "Muse Spark 1.2",
    package: packageName,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  {
    ...Model.Info.default(providerID, Model.ID.make("muse-spark-1.2-contributor")),
    name: "Muse Spark 1.2 (Contributor)",
    package: packageName,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  {
    ...Model.Info.default(providerID, Model.ID.make("muse-spark-1.1")),
    name: "Muse Spark 1.1",
    package: packageName,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
]

export const MetaPlugin = define({
  id: "orchestra.provider.meta",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const credentials = yield* Credential.Service
    const bus = yield* Bus.Service

    yield* ctx.integration.transform((editor) => {
      editor.update(integrationID, (integration) => {
        integration.name = name
      })
      editor.method.update({
        integrationID,
        method: { type: "key", label: "Meta Model API key" },
      })
      editor.method.update({
        integrationID,
        method: { type: "env", names: ["META_API_KEY", "MODEL_API_KEY"] },
      })
    })

    const connectedKey = Effect.fn("MetaPlugin.connectedKey")(function* () {
      const stored = yield* credentials.list(integrationID)
      return stored.flatMap((item) => (item.value.type === "key" ? [item.value.key] : []))[0]
    })

    const settings = Effect.fn("MetaPlugin.settings")(function* () {
      return metaSettings(yield* config.entries(), yield* connectedKey())
    })

    const source = { current: yield* settings() }

    yield* ctx.provider.transform((providers) => {
      if (!providers.get(providerID)) {
        providers.add({
          info: {
            ...Provider.Info.empty(providerID),
            name,
            package: packageName,
            integrationID,
          },
          models: [...models],
        })
      }
      providers.update(providerID, (provider) => {
        provider.name = name
        provider.package = packageName
        provider.integrationID = integrationID
        provider.settings = {
          ...source.current.settings,
          ...(source.current.apiKey ? { apiKey: source.current.apiKey } : {}),
        }
        if (source.current.configured) provider.activation = "enabled"
      })
    })

    const reload = Effect.fn("MetaPlugin.reload")(function* () {
      const next = yield* settings()
      if (next.baseURL === source.current.baseURL && next.apiKey === source.current.apiKey) return
      source.current = next
      yield* ctx.provider.reload()
    })

    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(reload),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* bus.subscribe([Credential.Event.Updated, Credential.Event.Switched]).pipe(
      Stream.runForEach(() => reload()),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)

export function metaSettings(entries: readonly Entry[], connected?: string) {
  const settings = foldSettings(entries, providerID, undefined) as
    | { apiKey?: unknown; baseURL?: unknown }
    | undefined
  const baseURL = (
    typeof settings?.baseURL === "string" ? settings.baseURL : defaultBaseURL
  ).replace(/\/+$/, "")
  // Connector key wins, then a hand-written config key, then the environment.
  // META_API_KEY takes precedence over MODEL_API_KEY, matching Meta's docs.
  const apiKey =
    connected !== undefined && connected.length > 0
      ? connected
      : typeof settings?.apiKey === "string" && settings.apiKey.length > 0
        ? settings.apiKey
        : process.env.META_API_KEY ?? process.env.MODEL_API_KEY
  return {
    baseURL,
    apiKey,
    configured: settings !== undefined || apiKey !== undefined,
    settings: settings ?? {},
  }
}
