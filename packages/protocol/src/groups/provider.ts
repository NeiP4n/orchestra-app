import { Provider } from "@orchestra/schema/provider"
import { Location } from "@orchestra/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProviderNotFoundError, ServiceUnavailableError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const DiscoverModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String.pipe(Schema.optional),
})

const DiscoverError = Schema.Struct({
  kind: Schema.String,
  message: Schema.String,
  status: Schema.Finite.pipe(Schema.optional),
})

/** A discovery outcome is data, not an HTTP error: failure kinds drive the manual-entry fallback. */
const DiscoverResult = Schema.Struct({
  ok: Schema.Boolean,
  reachable: Schema.Boolean,
  models: Schema.Array(DiscoverModel),
  latencyMs: Schema.Finite.pipe(Schema.optional),
  error: DiscoverError.pipe(Schema.optional),
})

export const ProviderGroup = HttpApiGroup.make("server.provider")
  .add(
    HttpApiEndpoint.get("provider.list", "/api/provider", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Provider.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "provider.list",
          summary: "List providers",
          description: "Retrieve active AI providers so clients can show provider availability and configuration.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("provider.get", "/api/provider/:providerID", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      success: Location.response(Provider.Info),
      error: [ProviderNotFoundError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "provider.get",
          summary: "Get provider",
          description: "Retrieve a single AI provider so clients can inspect its availability and endpoint settings.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("provider.discover", "/api/provider/discover", {
      payload: Schema.Struct({
        baseURL: Schema.String,
        /** Optional discovery budget; bounded to two minutes. */
        timeoutMs: Schema.Number.pipe(
          Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(120000)),
          Schema.optional,
        ),
        /** A key the user just typed (test before save). Omit to use the provider's stored credential. */
        apiKey: Schema.String.pipe(Schema.optional),
        headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
        /** When set and no apiKey is given, the endpoint's stored active key credential is used server-side. */
        providerID: Provider.ID.pipe(Schema.optional),
      }),
      success: DiscoverResult,
      error: ServiceUnavailableError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "provider.discover",
        summary: "Test an endpoint and discover its models",
        description:
          "Calls the endpoint's OpenAI-compatible /models API and returns the model list or a classified failure (auth, timeout, network, unsupported) so clients can fall back to manual model entry. API keys are used for the call only and never echoed back.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "provider",
      description: "Experimental provider routes.",
    }),
  )
