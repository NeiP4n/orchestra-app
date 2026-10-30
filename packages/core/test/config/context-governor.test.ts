import { describe, expect } from "bun:test"
import { Bus } from "@orchestra/core/bus"
import { Config } from "@orchestra/core/config"
import { ConfigContextGovernorPlugin } from "@orchestra/core/config/plugin/context-governor"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { SessionContextGovernor } from "@orchestra/core/session/context-governor"
import { ConfigExperimental } from "@orchestra/schema/config/experimental"
import { Document, Event, Info } from "@orchestra/schema/config"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const config = Config.testLayer()
const it = testEffect(Layer.merge(config, AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [Config.node.replace(config)])))

const entries = (enabled?: boolean) => [
  new Document({
    type: "document",
    info: new Info({ experimental: new ConfigExperimental.Info(enabled === undefined ? {} : { context_governor: enabled }) }),
  }),
]

describe("ConfigContextGovernorPlugin.Plugin", () => {
  it.live("follows the experimental.context_governor setting and its changes", () =>
    Effect.gen(function* () {
      const test = yield* Config.Test
      const bus = yield* Bus.Service
      yield* test.setEntries(entries(true))
      yield* ConfigContextGovernorPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))
      expect(SessionContextGovernor.policy()).toBeDefined()

      yield* test.setEntries(entries(false))
      yield* bus.publish(Event.Updated, {})
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (SessionContextGovernor.policy() === undefined) return
          yield* Effect.sleep("10 millis")
        }
        yield* Effect.die(new Error("Timed out waiting for the governor to turn off"))
      })
      expect(SessionContextGovernor.policy()).toBeUndefined()
    }).pipe(Effect.ensuring(Effect.sync(() => SessionContextGovernor.configure(false)))),
  )
})
