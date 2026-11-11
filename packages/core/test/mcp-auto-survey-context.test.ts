import { expect } from "bun:test"
import { Config } from "@orchestra/core/config"
import { Mcp } from "@orchestra/core/mcp/index"
import { Orchestra } from "@orchestra/core/orchestra"
import { Session } from "@orchestra/core/session"
import { McpManagerTool } from "@orchestra/core/tool/plugin/mcp-manager"
import type { SessionHooks } from "@orchestra/plugin/effect/session"
import { Agent } from "@orchestra/core/agent"
import { Model } from "@orchestra/core/model"
import { Provider } from "@orchestra/core/provider"
import { PluginHooks } from "@orchestra/core/plugin/hooks"
import { McpSurvey } from "@orchestra/core/mcp/survey"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { registerToolPlugin } from "./lib/tool"
import { PluginTestLayer } from "./plugin/fixture"

let writes = 0,
  connects = 0
const configLayer = Layer.succeed(Config.Service, {
  entries: () => Effect.succeed([]),
  changes: () => Stream.empty,
  update: () =>
    Effect.sync(() => {
      writes++
    }),
})
const mcpLayer = Layer.mock(Mcp.Service, {
  servers: () => inspectFails ? Effect.die(new Error("inspect offline")) :
    Effect.succeed(["context7", "deepwiki", "serena", "xerj"].map((name) => ({
      name, config: { type: "local" as const, command: ["unused"] }, status: { status: "disabled" as const },
    }))),
  tools: () => Effect.succeed([]),
  connect: () =>
    Effect.sync(() => {
      connects++
    }),
})
let metadata: Record<string, unknown> | undefined
let main = true
let inspectFails = false
const orchestraLayer = Layer.mock(Orchestra.Service, { roles: () => Effect.succeed([]), mainOf: () => Effect.succeed(main ? ({} as Orchestra.Project) : undefined) })
const sessionsLayer = Layer.mock(Session.Service, {
  revert: {
    stage: () => Effect.die("unused revert.stage"),
    clear: () => Effect.die("unused revert.clear"),
    commit: () => Effect.die("unused revert.commit"),
  },
  get: () => Effect.succeed({ metadata } as Session.Info),
  setMetadata: (input) => Effect.sync(() => { metadata = input.metadata }),
})
const it = testEffect(Layer.mergeAll(PluginTestLayer, configLayer, mcpLayer, orchestraLayer, sessionsLayer))

const context = (): SessionHooks["context"] => ({
  sessionID: Session.ID.make("ses_auto_survey"), agent: Agent.ID.make("build"),
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
  system: [], messages: [], tools: { mcp_manager: { description: "inspect", input: {} } }, options: {},
})
it.effect("main sees the complete read-only survey before its first dispatch; workers do not", () =>
  Effect.gen(function* () {
    metadata = undefined
    main = true
    const hooks = yield* PluginHooks.Service
    yield* registerToolPlugin(McpManagerTool.Plugin, { session: { hook: (name, callback) => hooks.register("session", name, callback) } })
    const first = context()
    yield* hooks.trigger("session", "context", first)
    expect(first.system.map((part) => part.text).join("\n")).toContain("context7")
    expect(first.system.map((part) => part.text).join("\n")).toContain("Installable from the catalog")
    expect(first.system.map((part) => part.text).join("\n")).toContain("Capability methods and adapters")
    expect(McpSurvey.isFresh(metadata)).toBe(true)
    const second = context()
    yield* hooks.trigger("session", "context", second)
    expect(second.system).toEqual(first.system)
    main = false
    const worker = context()
    yield* hooks.trigger("session", "context", worker)
    expect(worker.tools.mcp_manager).toBeUndefined()
    expect(worker.system).toEqual([])
    expect(writes).toBe(0)
    expect(connects).toBe(0)
  }),
)

it.effect("inspect failure leaves no usable stamp or partial survey in context", () =>
  Effect.gen(function* () {
    main = true
    metadata = { [McpSurvey.SURVEY_METADATA_KEY]: { at: Date.now(), configured: 1, catalog: 8 } }
    inspectFails = true
    const hooks = yield* PluginHooks.Service
    yield* registerToolPlugin(McpManagerTool.Plugin, { session: { hook: (name, callback) => hooks.register("session", name, callback) } })
    const event = context()
    yield* hooks.trigger("session", "context", event)
    expect(event.system).toEqual([])
    expect(McpSurvey.isFresh(metadata)).toBe(false)
    inspectFails = false
  }),
)
