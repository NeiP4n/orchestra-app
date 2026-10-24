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
import { KV } from "@orchestra/core/kv"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import { Location } from "@orchestra/core/location"
import { Orchestra } from "@orchestra/core/orchestra"
import { Permission } from "@orchestra/core/permission"
import { Session } from "@orchestra/core/session"
import { SessionExecution } from "@orchestra/core/session/execution"
import { Tool } from "@orchestra/core/tool"
import { DodTool } from "@orchestra/core/tool/plugin/dod"
import { AbsolutePath } from "@orchestra/core/schema"
import { withTempDir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { location } from "./fixture/location"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { permissionLayer } from "./lib/permission"

// The tool never runs a session here: it only edits the board.
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
  name: "test/dod-project-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(DodTool.Plugin)),
  deps: [Tool.node, Permission.node, Location.node, Orchestra.node],
})

const harness = (directory: string) =>
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
      Agent.node,
      Tool.node,
      pluginNode,
    ]),
    [
      SessionExecution.node.replace(idleExecution),
      Global.node.replace(tempGlobalLayer),
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ),
      Permission.node.replace(
        permissionLayer({ assert: () => Effect.void, confirm: () => Effect.void }),
      ),
      offlineModels,
    ],
  )

const run = (tools: Tool.Interface, sessionID: Session.ID, id: string, input: Record<string, unknown>) =>
  executeTool(tools, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call" as const, id, name: DodTool.name, input },
  })

const text = (result: { readonly content?: ReadonlyArray<Tool.Content> }) =>
  (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")

describe("DodTool through a real project", () => {
  it.live("adds as the project Orchestrator and refuses its worker", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const orchestra = yield* Orchestra.Service
        const tools = yield* Tool.Service
        const project = yield* orchestra.create({ name: "DoD Project", directory })
        const main = yield* orchestra.main(project.id)
        const role = (yield* orchestra.roles()).find((item) => item.id === "developer")!
        const worker = yield* orchestra.createMember({
          project,
          agent: role.agent,
          title: role.name,
          category: role.category,
        })

        const added = yield* run(tools, main.id, "main-add", { action: "add", what: "Own the board" })
        expect(text(added)).toContain("Added L-001")

        const refused = yield* run(tools, worker.id, "worker-add", {
          action: "add",
          what: "Grown by a worker",
        })
        expect(text(refused)).toBe("")
        expect(refused.error?.message).toContain(
          "DoD creation is owned by the project Orchestrator",
        )

        const board = yield* run(tools, main.id, "main-show", { action: "show" })
        expect(text(board)).toContain("Own the board")
        expect(text(board)).not.toContain("Grown by a worker")
      }).pipe(Effect.provide(harness(directory))),
    ),
  )
})
