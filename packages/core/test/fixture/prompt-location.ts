import type { FileSystem } from "@orchestra/core/filesystem"
import { Bus } from "@orchestra/core/bus"
import { Image } from "@orchestra/core/image"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import type { LocationServices } from "@orchestra/core/location-services"
import { Plugin } from "@orchestra/core/plugin"
import { PluginHooks } from "@orchestra/core/plugin/hooks"
import { Skill } from "@orchestra/core/skill"
import type { Location } from "@orchestra/schema/location"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Effect, Layer, LayerMap } from "effect"

// Plain-prompt unit fixtures use virtual directories.
export const promptLocationNode = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      return yield* LayerMap.make(
        (_ref: Location.Ref) =>
          LayerNode.compile(LayerNode.group([PluginHooks.node, Image.node, Skill.node, Plugin.node]), {
            replacements: [
              Bus.node.replace(Layer.succeed(Bus.Service, bus)),
              Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
            ],
          }) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      )
    }),
  ),
  deps: [Bus.node],
})
