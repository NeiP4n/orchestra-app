import { Clock, Effect, Layer } from "effect"
import { Orchestra } from "@orchestra/core/orchestra"

// Supervisor tests advance their clock by days. Keep the real unrelated Orchestra
// trigger/report sweeps on live time, without removing their service or policy hooks.
export const liveOrchestra = Orchestra.node.replace(
  Orchestra.node.mapLayer((layer) =>
    Layer.effectContext(Effect.provideService(Layer.build(layer), Clock.Clock, Clock.Clock.defaultValue())),
  ),
)
