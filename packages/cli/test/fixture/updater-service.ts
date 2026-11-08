import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { AppProcess } from "@orchestra/util/process"
import { Npm } from "@orchestra/util/npm"
import { EffectFlock } from "@orchestra/util/effect-flock"
import { Updater } from "../../src/services/updater"

const record = (event: unknown) => console.log(`EVENT ${JSON.stringify(event)}`)

// Drives the REAL Updater service (not the command fixture's mock) so the
// build-capability guards in inspect, check and apply are exercised directly.
await Effect.runPromise(
  Effect.gen(function* () {
    const updater = yield* Updater.Service

    const status = yield* updater.check()
    record({ check: status })

    const applied = yield* updater.apply("0.0.0-beta-new").pipe(
      Effect.map(() => ({ ok: true })),
      Effect.catch((error) => Effect.succeed({ failed: String(error) })),
    )
    record({ apply: applied })

    const ran = yield* updater.run()
    record({ run: ran ?? null })
  }).pipe(
    Effect.provide(Updater.layer),
    Effect.provide(LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, Npm.node, EffectFlock.node]))),
    Effect.provide(NodeServices.layer),
  ),
)
