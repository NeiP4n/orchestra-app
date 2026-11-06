import { createEffect, onCleanup } from "solid-js"
import { getSharedNeuralActivity } from "@orchestra/ui/neural-field"
import { useServerSDK } from "@/runtime/server/client"
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

// Feeds the shared neural activity from the current server's event stream.
// Mounted once in the shell, so every canvas on screen shares one tracker.
export function NeuralFeed() {
  const serverSDK = useServerSDK()
  const activity = getSharedNeuralActivity()
  onCleanup(serverSDK.event.listen((event) => activity.take(event)))
  return null
}
