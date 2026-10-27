import { Event } from "@orchestra/schema/event"
import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { EventFeed } from "../event-feed"

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const feed = yield* EventFeed.Service
    return handlers.handleRaw("event.subscribe", (ctx) =>
      Effect.gen(function* () {
        const lastEventID =
          ctx.request.headers["last-event-id"] ??
          new URL(ctx.request.url, "http://localhost").searchParams.get("lastEventID") ??
          undefined
        const connected = {
          id: Event.ID.create(),
          type: "server.connected",
          data: {},
        } as const
        const stream = yield* feed.stream({ lastEventID })
        const output = Stream.make(EventFeed.frame(connected)).pipe(Stream.concat(stream))
        return HttpServerResponse.stream(output.pipe(Stream.encodeText), {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
          },
        })
      }),
    )
  }),
)
