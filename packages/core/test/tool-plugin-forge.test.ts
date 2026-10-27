import { expect } from "bun:test"
import { Config } from "@orchestra/core/config"
import { AbsolutePath } from "@orchestra/core/schema"
import { Session } from "@orchestra/core/session"
import { Tool } from "@orchestra/core/tool"
import { PluginForgeTool } from "@orchestra/core/tool/plugin/plugin-forge"
import type { Patch } from "@orchestra/schema/config"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity, waitForTool } from "./lib/tool"
import { PluginTestLayer } from "./plugin/fixture"

const patches: Patch[] = []
let currentPlugins: string[] = ["plugin-alpha", "-plugin-beta"]

const configLayer = Layer.succeed(Config.Service, {
  entries: () => Effect.sync(() => [
    {
      type: "document" as const,
      path: AbsolutePath.make("/fake/orchestra.jsonc"),
      info: { plugins: [...currentPlugins] },
    },
  ]),
  changes: () => Stream.empty,
  update: (patch) =>
    Effect.sync(() => {
      patches.push(patch)
      if (patch.plugins) {
        currentPlugins = patch.plugins as string[]
      }
    }),
})

const it = testEffect(Layer.merge(PluginTestLayer, configLayer))
const sessionID = Session.ID.make("ses_plugin_forge_test")

const setup = Effect.gen(function* () {
  const tools = yield* Tool.Service
  yield* registerToolPlugin(PluginForgeTool.Plugin, {
    command: {
      list: () => Effect.die("unused command.list"),
      transform: (callback) => {
        callback({ add: () => {} })
        return Effect.succeed({ dispose: Effect.void })
      },
      reload: () => Effect.void,
    },
  })
  yield* waitForTool(tools, "plugin_forge")
  return tools
})

const run = (tools: Tool.Interface, id: string, input: Record<string, unknown>) =>
  executeTool(tools, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call" as const, id, name: "plugin_forge", input },
  })

const text = (result: { readonly content?: ReadonlyArray<Tool.Content>; readonly output?: any }) => {
  if (result.output && typeof result.output.output === "string") return result.output.output
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
}

it.effect("lists installed and disabled plugins", () =>
  Effect.gen(function* () {
    const tools = yield* setup
    const result = yield* run(tools, "c1", { action: "list" })
    const output = text(result)
    expect(output).toContain("plugin-beta")
    expect(output).toContain("disabled")
  }),
)

it.effect("enables a disabled plugin", () =>
  Effect.gen(function* () {
    const tools = yield* setup
    const result = yield* run(tools, "c2", { action: "enable", package: "plugin-beta" })
    const output = text(result)
    expect(output).toContain('Plugin "plugin-beta" enabled')
    expect(currentPlugins).toContain("plugin-beta")
    expect(currentPlugins).not.toContain("-plugin-beta")
  }),
)

it.effect("disables an active plugin", () =>
  Effect.gen(function* () {
    const tools = yield* setup
    const result = yield* run(tools, "c3", { action: "disable", package: "plugin-alpha" })
    const output = text(result)
    expect(output).toContain('Plugin "plugin-alpha" disabled')
    expect(currentPlugins).toContain("-plugin-alpha")
  }),
)

it.effect("removes a plugin", () =>
  Effect.gen(function* () {
    const tools = yield* setup
    const result = yield* run(tools, "c4", { action: "remove", package: "plugin-alpha" })
    const output = text(result)
    expect(output).toContain('Plugin "plugin-alpha" removed')
    expect(currentPlugins).not.toContain("plugin-alpha")
    expect(currentPlugins).not.toContain("-plugin-alpha")
  }),
)

it.effect("adds a new plugin", () =>
  Effect.gen(function* () {
    const tools = yield* setup
    const result = yield* run(tools, "c5", { action: "add", package: "new-plugin" })
    const output = text(result)
    expect(output).toContain('Plugin "new-plugin" added')
    expect(currentPlugins).toContain("new-plugin")
  }),
)
