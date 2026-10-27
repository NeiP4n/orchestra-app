export * as AgiService from "./agi-node.js"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Location } from "./location.js"
import { AgiNetworkRuntime, type AgiRuntimeStatus, type ComplexityAssessment } from "./agi/runtime.js"
import type { CognitiveMode } from "./agi/cognitive-mode.js"

export interface Interface {
  readonly runtime: AgiNetworkRuntime
  readonly assess: (task: string) => ComplexityAssessment
  readonly status: () => AgiRuntimeStatus
  readonly mode: () => CognitiveMode
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/AgiService") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const runtime = AgiNetworkRuntime.instance({
      nodeId: `node-${location.project.id}`,
    })

    const assess = (task: string) => runtime.cognitiveMode.assessComplexity(task)
    const status = () => runtime.status()
    const mode = () => runtime.status().mode

    return Service.of({
      runtime,
      assess,
      status,
      mode,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node],
})

