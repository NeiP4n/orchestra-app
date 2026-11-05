export * as ServerEvent from "./server-event.js"

import { Schema } from "effect"
import { Event } from "./event.js"

export const Connected = Event.ephemeral({ type: "server.connected", schema: {} })
export const Disposed = Event.ephemeral({ type: "global.disposed", schema: {} })

// Sent first on a reconnect when the client's last event fell out of the replay
// window: the events since that ID are gone, so the client resyncs from the API
// instead of silently showing state that lost events.
export const ReplayGap = Event.ephemeral({
  type: "server.replay-gap",
  schema: {
    lastEventID: Schema.String,
  },
})

export const Definitions = Event.inventory(Connected, Disposed, ReplayGap)
