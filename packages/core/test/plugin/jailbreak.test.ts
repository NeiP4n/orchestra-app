import { describe, expect } from "bun:test"
import { Bus } from "@orchestra/core/bus"
import { Config } from "@orchestra/core/config"
import { Agent } from "@orchestra/core/agent"
import { Jailbreak } from "@orchestra/core/jailbreak"
import { Model } from "@orchestra/core/model"
import { Provider } from "@orchestra/core/provider"
import { Plugin } from "@orchestra/core/plugin"
import { PluginHost } from "@orchestra/core/plugin/host"
import { JailbreakPlugin } from "@orchestra/core/plugin/jailbreak"
import { Session } from "@orchestra/core/session"
import type { SessionContext } from "@orchestra/plugin/effect/session"
import { Document, Event, Info } from "@orchestra/schema/config"
import { ConfigJailbreak } from "@orchestra/schema/config/jailbreak"
import { Mode } from "@orchestra/schema/mode"
import type { Session as SessionSchema } from "@orchestra/schema/session"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

const event = (model = "test") =>
  ({
    sessionID: Session.ID.make("ses_jailbreak"),
    agent: Agent.ID.make("build"),
    model: Model.Ref.make({ id: Model.ID.make(model), providerID: Provider.ID.make("test") }),
    system: [{ type: "text", text: "Agent prompt" }],
    messages: [],
    options: {},
    tools: {},
  }) as unknown as SessionContext

/** Installs the plugin and returns the context hook it registered. */
const install = (running: () => string | undefined) =>
  Effect.gen(function* () {
    let hook: ((input: SessionContext) => Effect.Effect<void>) | undefined
    const plugins = yield* Plugin.Service
    const base = yield* PluginHost.make(plugins)
    yield* JailbreakPlugin.Plugin.effect({
      ...base,
      session: {
        ...base.session,
        hook: (name, callback) => {
          if (name === "context") hook = callback as (input: SessionContext) => Effect.Effect<void>
          return Effect.succeed({ dispose: Effect.void })
        },
        get: () =>
          Effect.succeed({
            metadata: running() === undefined ? {} : { [Mode.MetadataKey]: running() },
          } as unknown as SessionSchema.Info),
      },
    })
    return (input: SessionContext) => hook!(input)
  })

const run = (hook: (input: SessionContext) => Effect.Effect<void>, model?: string) =>
  Effect.gen(function* () {
    const input = event(model)
    yield* hook(input)
    return input.system.map((part) => part.text)
  })

describe("JailbreakPlugin.Plugin", () => {
  it.effect("stays silent when the config turns the mode off", () =>
    Effect.gen(function* () {
      const config = yield* Config.Test
      yield* config.setEntries([configured({ enabled: false, prompt: "deepseek-4-1" })])
      const hook = yield* install(() => "jailbreak")

      expect(yield* run(hook)).toEqual(["Agent prompt"])
    }),
  )

  it.effect("works with no jailbreak config at all", () =>
    Effect.gen(function* () {
      const config = yield* Config.Test
      yield* config.setEntries([new Document({ type: "document", info: new Info({}) })])
      const hook = yield* install(() => "jailbreak")

      const prompt = Jailbreak.find(Jailbreak.defaultID)
      if (!prompt) throw new Error("the default prompt is missing")
      expect(yield* run(hook)).toEqual(["Agent prompt", prompt.text])
    }),
  )

  it.effect("picks the bundled prompt that fits the model", () =>
    Effect.gen(function* () {
      const config = yield* Config.Test
      yield* config.setEntries([new Document({ type: "document", info: new Info({}) })])
      const hook = yield* install(() => "jailbreak")

      const prompt = Jailbreak.find("deepseek-4-1")
      if (!prompt) throw new Error("the bundled prompt is missing")
      expect(yield* run(hook, "deepseek-v4.1-flash-1017")).toEqual(["Agent prompt", prompt.text])
    }),
  )

  it.effect("adds the selected policy to a session running the mode", () =>
    Effect.gen(function* () {
      const config = yield* Config.Test
      yield* config.setEntries([configured({ enabled: true, prompt: "deepseek-4-1" })])
      const hook = yield* install(() => "jailbreak")

      const prompt = Jailbreak.find("deepseek-4-1")
      if (!prompt) throw new Error("the bundled prompt is missing")
      expect(prompt.id).toBe("deepseek-4-1")
      expect(yield* run(hook)).toEqual(["Agent prompt", prompt.text])
    }),
  )

  it.effect("runs the policy the session's mode pins, ahead of config and model matching", () =>
    Effect.gen(function* () {
      const config = yield* Config.Test
      yield* config.setEntries([configured({ enabled: true, prompt: "deepseek-4-1" })])
      const hook = yield* install(() => "jailbreak:opus-v2")

      const prompt = Jailbreak.find("opus-v2")
      if (!prompt) throw new Error("the bundled prompt is missing")
      expect(prompt.id).toBe("opus-v2")
      expect(yield* run(hook, "deepseek-v4.1-flash-1017")).toEqual(["Agent prompt", prompt.text])
    }),
  )

  it.effect("falls back to the default policy when the pinned one is no longer bundled", () =>
    Effect.gen(function* () {
      const config = yield* Config.Test
      yield* config.setEntries([new Document({ type: "document", info: new Info({}) })])
      const hook = yield* install(() => "jailbreak:gone")

      const prompt = Jailbreak.find(Jailbreak.defaultID)
      if (!prompt) throw new Error("the default prompt is missing")
      expect(yield* run(hook)).toEqual(["Agent prompt", prompt.text])
    }),
  )

  it.effect("leaves the ordinary modes untouched", () =>
    Effect.gen(function* () {
      const config = yield* Config.Test
      yield* config.setEntries([configured({ enabled: true })])
      const hook = yield* install(() => "coding")

      expect(yield* run(hook)).toEqual(["Agent prompt"])
    }),
  )

  it.effect("falls back to the default prompt for an unknown id", () =>
    Effect.gen(function* () {
      const config = yield* Config.Test
      yield* config.setEntries([configured({ enabled: true, prompt: "missing-prompt" })])
      const hook = yield* install(() => "jailbreak")

      const prompt = Jailbreak.find(Jailbreak.defaultID)
      if (!prompt) throw new Error("the default prompt is missing")
      expect(yield* run(hook)).toEqual(["Agent prompt", prompt.text])
    }),
  )

  it.live("follows the config without a restart", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const config = yield* Config.Test
      yield* config.setEntries([configured({ enabled: true, prompt: "deepseek-4-1" })])
      const hook = yield* install(() => "jailbreak")

      yield* config.setEntries([configured({ enabled: false })])
      yield* bus.publish(Event.Updated, {})
      yield* waitUntil(run(hook).pipe(Effect.map((parts) => parts.length === 1)))

      expect(yield* run(hook)).toEqual(["Agent prompt"])
    }),
  )
})

function configured(jailbreak: { enabled: boolean; prompt?: string }): Document {
  return new Document({ type: "document", info: new Info({ jailbreak: new ConfigJailbreak.Info(jailbreak) }) })
}

const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (yield* condition) return
    yield* Effect.sleep("10 millis")
  }
  throw new Error("condition was not met")
})
