import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Global } from "@orchestra/util/global"
import { Agent } from "@orchestra/core/agent"
import { Database } from "@orchestra/core/database/database"
import { KV } from "@orchestra/core/kv"
import { Location } from "@orchestra/core/location"
import { Model } from "@orchestra/schema/model"
import { Provider } from "@orchestra/schema/provider"
import { Session } from "@orchestra/core/session"
import { SessionMessage } from "@orchestra/core/session/message"
import { Tool } from "@orchestra/core/tool"
import { BudgetTool } from "@orchestra/core/tool/plugin/budget"
import { AbsolutePath } from "@orchestra/core/schema"
import { location } from "./fixture/location"
import { tempGlobalLayer } from "./fixture/global"
import { withTempDir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_budget_tool_test")
const ref = Model.Ref.make({ id: Model.ID.make("m"), providerID: Provider.ID.make("p") })

// One assistant step that already burned 600 tokens on p/m.
const spent = {
  type: "assistant",
  id: SessionMessage.ID.make("msg_budget_spent"),
  time: { created: DateTime.makeUnsafe(0) },
  agent: Agent.ID.make("build"),
  model: ref,
  finish: "stop",
  content: [],
  tokens: { input: 400, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
} as unknown as SessionMessage.Info

const sessionStub = Session.Service.of({
  messages: () => Effect.succeed([spent]),
  get: () => Effect.succeed({ model: ref }),
} as unknown as Session.Interface)

const pluginNode = makeLocationNode({
  name: "test/budget-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(BudgetTool.Plugin)),
  deps: [Tool.node, Session.node, KV.node],
})

function harness(directory: string) {
  return AppNodeBuilder.build(LayerNode.group([Tool.node, pluginNode, Database.node, KV.node]), [
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ),
    Session.node.replace(Layer.succeed(Session.Service, sessionStub)),
    Global.node.replace(tempGlobalLayer),
  ])
}

const run = (tools: Tool.Interface, id: string, input: Record<string, unknown>) =>
  executeTool(tools, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call" as const, id, name: BudgetTool.name, input },
  })

const text = (result: { readonly content?: ReadonlyArray<Tool.Content> }) =>
  (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")

describe("BudgetTool", () => {
  it.live("a limit set once keeps binding later calls, and a spent budget refuses", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const tools = yield* Tool.Service

        // 600 of 1,000 tokens spent; the limit is named here and stored for the session.
        const first = text(yield* run(tools, "status-1", { action: "status", limits: { "p/m": 1000 } }))
        expect(first).toContain("budget 1.0k, 400 left")
        expect(first).toContain("Stored budget set by build")

        // No limits passed this time: the stored budget still applies.
        const second = text(yield* run(tools, "status-2", { action: "status" }))
        expect(second).toContain("budget 1.0k, 400 left")
        expect(second).toContain("Stored budget set by build")

        // 500 tokens do not fit into the 400 left.
        const tight = text(yield* run(tools, "forecast-1", { action: "forecast", model: "p/m", tokens: 500 }))
        expect(tight).toContain("It does not fit")

        // A smaller task still fits.
        const fits = text(yield* run(tools, "forecast-2", { action: "forecast", model: "p/m", tokens: 100 }))
        expect(fits).toContain("It fits")

        // Lower the budget to exactly what is spent: nothing is left, and forecast refuses.
        yield* run(tools, "status-3", { action: "status", limits: { "p/m": 600 } })
        const exhausted = yield* run(tools, "forecast-3", { action: "forecast", model: "p/m", tokens: 10 })
        expect(exhausted.status).toBe("error")
        expect(exhausted.error?.message).toContain("Budget exhausted for p/m")
      }).pipe(Effect.provide(harness(directory))),
    ),
  )
})
