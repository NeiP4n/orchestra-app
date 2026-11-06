import { createEffect, onCleanup } from "solid-js"
import { getSharedNeuralActivity } from "@orchestra/ui/neural-field"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { useSettings } from "@/settings/model"

// Mirrors settings.appearance.animations onto <html data-motion>, the one
// source of truth the neural canvases, the sculk spinner and the CSS
// kill-switch all read. Mounted once in the app root.
export function MotionAttribute() {
  const settings = useSettings()
  createEffect(() => {
    if (typeof document === "undefined") return
    document.documentElement.dataset.motion = settings.appearance.animations() ? "on" : "off"
  })
  return null
}

// Feeds the shared neural activity from a live server's event stream.
// Mounted once in the shell, so every canvas on screen shares one tracker.
// The shell sits ABOVE the per-route ServerProvider, so the route-level
// useServerSDK() is unavailable here — and on first launch there is no
// server at all yet. Subscribe through the global registry instead, and
// stay quiet (no throw) while no healthy server exists.
export function NeuralFeed() {
  const global = useGlobal()
  const activity = getSharedNeuralActivity()

  createEffect(() => {
    const healthy = global.servers
      .list()
      .find((conn) => global.servers.health[ServerConnection.key(conn)]?.healthy)
    if (!healthy) return

    const ctx = global.serverCtx(ServerConnection.key(healthy))
    if (!ctx) return

    onCleanup(ctx.sdk.event.listen((event) => activity.take(event)))
  })

  return null
}
