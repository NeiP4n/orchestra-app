import { Location } from "@orchestra/schema/location"
import { Model } from "@orchestra/schema/model"
import { Recovery } from "@orchestra/schema/recovery"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

/**
 * Recovery mini-chat (Б12): the fallback entry point when Orchestra itself
 * is broken and the normal UI cannot be entered. The page is static HTML
 * served at /recovery; these endpoints are the only server surface it needs.
 */
export const RecoveryGroup = HttpApiGroup.make("server.recovery")
  .add(
    HttpApiEndpoint.get("recovery.models", "/api/recovery/models", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Recovery.RecoveryModel)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "recovery.models",
          summary: "List recovery models",
          description:
            "Models the recovery mini-chat offers: working providers only (klinch and lix). Dead providers are never listed.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("recovery.chat", "/api/recovery/chat", {
      query: LocationQuery,
      payload: Schema.Struct({
        model: Model.Ref,
        // At most 20 messages (T3-6): one request is at most one repair round, not an
        // unbounded transcript fed to the model.
        messages: Recovery.RecoveryChatTranscript,
      }),
      success: Recovery.RecoveryResult,
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "recovery.chat",
          summary: "Repair round",
          description:
            "One autonomous repair round with the chosen model: it reads and edits the Orchestra repo, runs shell commands and tests, and reports what it fixed. A model or provider failure is returned as a reply, not an HTTP error. One round runs at a time per server (a second concurrent request is refused with 503) and a round times out after 10 minutes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "recovery",
      description: "Recovery mini-chat routes.",
    }),
  )
