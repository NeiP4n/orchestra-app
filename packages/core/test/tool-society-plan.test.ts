import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { makeGlobalNode, makeLocationNode } from "@orchestra/util/effect/app-node"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Database } from "@orchestra/core/database/database"
import { Bus } from "@orchestra/core/bus"
import { Agent } from "@orchestra/core/agent"
import { Job } from "@orchestra/core/job"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import { Orchestra } from "@orchestra/core/orchestra"
import { Federation } from "@orchestra/core/federation"
import { Session } from "@orchestra/core/session"
import { SessionExecution } from "@orchestra/core/session/execution"
import { Money } from "@orchestra/schema/money"
import { SessionPlan } from "@orchestra/core/session/plan"
import { KV } from "@orchestra/core/kv"
import { Location } from "@orchestra/core/location"
import { Permission } from "@orchestra/core/permission"
import { Tool } from "@orchestra/core/tool"
import { FederationTool } from "@orchestra/core/tool/plugin/federation"
import { SocietyPlanTool } from "@orchestra/core/tool/plugin/society-plan"
import { AbsolutePath } from "@orchestra/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { permissionLayer } from "./lib/permission"

// Group configuration never runs a session, so every execution stays idle.
const idleExecution = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.succeed(false),
      awaitIdle: () => Effect.void,
    }),
  ),
  deps: [],
})

const pluginNode = makeLocationNode({
  name: "test/society-plan-tool-plugin",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      yield* registerToolPlugin(FederationTool.Plugin)
      yield* registerToolPlugin(SocietyPlanTool.Plugin)
    }),
  ),
  deps: [Tool.node, Federation.node, Orchestra.node, Session.node, Permission.node, Database.node, KV.node],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Job.node,
      Session.node,
      KV.node,
      SessionExecution.node,
      LocationServiceMap.node,
      Orchestra.node,
      Federation.node,
      Agent.node,
      Tool.node,
      pluginNode,
    ]),
    [
      SessionExecution.node.replace(idleExecution),
      Global.node.replace(tempGlobalLayer),
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ),
      Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
      offlineModels,
    ],
  ),
)

const setup = Effect.gen(function* () {
  const orchestra = yield* Orchestra.Service
  const tools = yield* Tool.Service
  const dirs = yield* Effect.all([
    Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-society-plan-a-"))),
    Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-society-plan-b-"))),
  ])
  const a = yield* orchestra.create({ name: "Frontend", directory: dirs[0].path })
  const b = yield* orchestra.create({ name: "Backend", directory: dirs[1].path })
  // A council group with its Society chat, so the first project's main
  // Orchestrator plans as the Society's planner.
  yield* runFederation(tools, a.main!, "create", {
    action: "group_create",
    name: "Shop",
    projects: [a.id, b.id],
    mode: "council",
  })
  yield* runFederation(tools, a.main!, "chat", { action: "group_chat", name: "Shop" })
  return { a, b }
})

const run = (tools: Tool.Interface, sessionID: Session.ID, id: string, input: Record<string, unknown>) =>
  executeTool(tools, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call" as const, id, name: SocietyPlanTool.name, input },
  })

const runFederation = (tools: Tool.Interface, sessionID: Session.ID, id: string, input: Record<string, unknown>) =>
  executeTool(tools, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call" as const, id, name: FederationTool.name, input },
  })

const text = (result: { readonly content?: ReadonlyArray<Tool.Content>; readonly error?: unknown }) => {
  const output = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
  if (!output) throw new Error(`society_plan tool failed: ${JSON.stringify(result.error)}`)
  // The tool returns { output: string }; unwrap it so expectations read the
  // plain text instead of the JSON-escaped form.
  try {
    const parsed = JSON.parse(output) as { output?: unknown }
    return typeof parsed.output === "string" ? parsed.output : output
  } catch {
    return output
  }
}

describe("SocietyPlanTool storage", () => {
  it.live("stores planner decisions and the budget as data and reports spend in status", () =>
    Effect.gen(function* () {
      const { a } = yield* setup
      const tools = yield* Tool.Service
      const federation = yield* Federation.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service

      const before = text(yield* run(tools, a.main!, "status", { action: "status" }))
      expect(before).toContain('Society "Shop"')
      expect(before).toContain("Frontend")
      expect(before).toContain("Backend")
      expect(before).toContain("Spend:")
      expect(before).toContain("Society total: 0 tokens · $0.00")

      const applied = text(
        yield* run(tools, a.main!, "apply", {
          action: "apply",
          chats: [
            { project: a.id, context: 300000, cache: true },
            { project: "society", model: "anthropic/claude-sonnet-4-5" },
          ],
          budget: 100,
        }),
      )
      expect(applied).toContain("budget $100.00")

      // The budget lives on the group, not in a prompt.
      expect((yield* federation.groups()).find((group) => group.name === "Shop")?.budget).toBe(Money.USD.make(100))
      // The decisions live in KV, not in a chat transcript.
      const decision = yield* kv.get(`federation/society-plan/Shop/${a.id}/all`)
      expect(decision).toEqual({ context: 300000, cache: true })
      // The live chats got the settings too.
      const main = yield* sessions.get(a.main!)
      expect(main.metadata?.[SessionPlan.CONTEXT_KEY]).toBe(300000)
      expect(main.metadata?.[SessionPlan.CACHE_KEY]).toBe("auto")

      const after = text(yield* run(tools, a.main!, "status", { action: "status" }))
      expect(after).toContain("Budget $100.00 · $100.00 left")
      expect(after).toContain("- Frontend: 0 tokens · $0.00")
      expect(after).toContain("Planned:")
      expect(after).toContain("- Frontend · context 300000 tokens · cache on")
      expect(after).toContain("- Society chat · anthropic/claude-sonnet-4-5")

      // Changing one field keeps the earlier decisions for the same chat.
      yield* run(tools, a.main!, "apply2", {
        action: "apply",
        chats: [{ project: a.id, model: "anthropic/claude-sonnet-4-5" }],
      })
      expect(yield* kv.get(`federation/society-plan/Shop/${a.id}/all`)).toEqual({
        model: "anthropic/claude-sonnet-4-5",
        context: 300000,
        cache: true,
      })

      // A non-positive budget is a skipped line, not a stored one.
      const refused = text(
        yield* run(tools, a.main!, "apply3", { action: "apply", chats: [], budget: -5 }),
      )
      expect(refused).toContain("not a positive USD limit")
      expect((yield* federation.groups()).find((group) => group.name === "Shop")?.budget).toBe(Money.USD.make(100))
    }),
  )
})
