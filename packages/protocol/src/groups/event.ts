import { Event } from "@orchestra/schema/event"
import { EventManifest } from "@orchestra/schema/event-manifest"
import { Location } from "@orchestra/schema/location"
import type { Definition } from "@orchestra/schema/event"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

const fields = {
  id: Event.ID,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  location: Schema.optional(Location.PublicRef),
}

const rpcEvent = Schema.Struct({
  id: Event.ID,
  created: Schema.Finite,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  type: Schema.TemplateLiteral(["rpc.", Schema.String]),
  location: Location.PublicRef,
  data: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "V2Event.rpc" })

const schema = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) =>
  Schema.Union([
    ...definitions,
    rpcEvent,
    ...(definitions.some((definition) => definition.type === "server.connected")
      ? []
      : [
          Schema.Struct({
            ...fields,
            type: Schema.Literal("server.connected"),
            data: Schema.Struct({}),
          }).annotate({ identifier: "V2Event.server.connected" }),
        ]),
  ]).annotate({ identifier: "V2Event" })

const make = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) => {
  const EventSchema = schema(definitions)
  return {
    schema: EventSchema,
    group: HttpApiGroup.make("server.event")
      .add(
        HttpApiEndpoint.get("event.subscribe", "/api/event", {
          success: HttpApiSchema.StreamSse({ data: EventSchema }),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "event.subscribe",
            summary: "Subscribe to events",
            description:
              "Subscribe to native events and plugin RPC events across all server locations. Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are missed.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "event", description: "Experimental event stream routes." })),
  }
}

export const makeEventGroup = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) =>
  make(definitions).group

const event = make(EventManifest.ServerDefinitions)
export const EventGroup = event.group
export const OrchestraEvent = event.schema
export type OrchestraEvent = typeof OrchestraEvent.Type
export type OrchestraEventEncoded = typeof OrchestraEvent.Encoded
export const isOrchestraEvent = (event: { readonly type: string }): event is OrchestraEvent =>
  event.type === "server.connected" || EventManifest.isServer(event) || event.type.startsWith("rpc.")

// Compatibility aliases for the public event surface. The rename to OrchestraEvent
// is not yet propagated to every client consumer; remove these once it is.
/** @deprecated use OrchestraEvent */
export const OpenCodeEvent = OrchestraEvent
/** @deprecated use OrchestraEvent */
export type OpenCodeEvent = OrchestraEvent
/** @deprecated use OrchestraEventEncoded */
export type OpenCodeEventEncoded = OrchestraEventEncoded
/** @deprecated use isOrchestraEvent */
export const isOpenCodeEvent = isOrchestraEvent
