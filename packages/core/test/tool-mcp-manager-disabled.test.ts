import { expect } from "bun:test"
import { Config } from "@orchestra/core/config"
import { Mcp } from "@orchestra/core/mcp/index"
import { Orchestra } from "@orchestra/core/orchestra"
import { Session } from "@orchestra/core/session"
import { Tool } from "@orchestra/core/tool"
import { McpManagerTool } from "@orchestra/core/tool/plugin/mcp-manager"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity, waitForTool } from "./lib/tool"
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
  servers: () =>
    Effect.succeed(["context7", "deepwiki", "serena", "xerj"].map((name) => ({
      name, config: { type: "local" as const, command: ["unused"] }, status: { status: "disabled" as const },
    }))),
  tools: () => Effect.succeed([]),
  connect: () =>
    Effect.sync(() => {
      connects++
    }),
})
const orchestraLayer = Layer.mock(Orchestra.Service, { roles: () => Effect.succeed([]) })
const it = testEffect(Layer.mergeAll(PluginTestLayer, configLayer, mcpLayer, orchestraLayer))
it.effect("agent enable asks the operator, even with a model-supplied approved flag", () =>
  Effect.gen(function* () {
    const tools = yield* Tool.Service
    yield* registerToolPlugin(McpManagerTool.Plugin)
    yield* waitForTool(tools, "mcp_manager")
    const result = yield* executeTool(tools, {
      sessionID: Session.ID.make("ses_off_guard"),
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "off-enable",
        name: "mcp_manager",
        input: { action: "enable", server: "context7", approved: true },
      },
    })
    expect(result.status).toBe("completed")
    const output = JSON.stringify(result.output)
    expect(output).toContain("Operator approval required")
    const acquired = yield* executeTool(tools, {
      sessionID: Session.ID.make("ses_off_guard"),
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "off-acquire",
        name: "mcp_manager",
        input: { action: "acquire", server: "context7" },
      },
    })
    expect(acquired.status).toBe("completed")
    const inspected = yield* executeTool(tools, {
      sessionID: Session.ID.make("ses_off_guard"), ...toolIdentity,
      call: { type: "tool-call", id: "off-inspect", name: "mcp_manager", input: { action: "inspect" } },
    })
    expect(inspected.status).toBe("completed")
    expect(JSON.stringify(inspected.output)).toContain("Capability methods and adapters")
    expect(JSON.stringify(inspected.output)).toContain("Unknown cost is not free")
    expect(writes).toBe(0)
    expect(connects).toBe(0)
  }),
)
