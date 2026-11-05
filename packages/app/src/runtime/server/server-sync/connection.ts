import { createEffect, type Accessor } from "solid-js"
import type { ServerConnectionStatus } from "../client"

export function createConnectionSync(input: {
  status: Accessor<ServerConnectionStatus>
  invalidate: () => void
  connected: (info: { reconnect: boolean }) => void
}) {
  createEffect(() => {
    if (input.status() === "connected") return
    input.invalidate()
  })

  let connectedOnce = false

  function handleEvent(event: { type: string }) {
    // The server could not replay the events since our last ID (long disconnect,
    // restart): resync from the API instead of showing state that quietly lost events.
    if (event.type === "server.replay-gap") {
      input.connected({ reconnect: true })
      return
    }
    if (event.type !== "server.connected") return
    input.connected({ reconnect: connectedOnce })
    connectedOnce = true
  }

  return { handleEvent }
}

// Directories a mounted view holds refresh first; the rest keep their existing order behind them.
export function reconnectOrder(directories: string[], held: (directory: string) => boolean) {
  return [...directories.filter(held), ...directories.filter((directory) => !held(directory))]
}
