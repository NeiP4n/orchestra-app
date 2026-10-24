import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Dod } from "@orchestra/core/dod"
import { Orchestra } from "@orchestra/core/orchestra"
import { Location } from "@orchestra/core/location"
import { DodTool } from "@orchestra/core/tool/plugin/dod"
import { Permission } from "@orchestra/core/permission"
import { Session } from "@orchestra/core/session"
import { Tool } from "@orchestra/core/tool"
import { AbsolutePath } from "@orchestra/core/schema"
import { location } from "./fixture/location"
import { withTempDir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { orchestraLayer } from "./lib/orchestra"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_dod_tool_test")

const pluginNode = makeLocationNode({
  name: "test/dod-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(DodTool.Plugin)),
  deps: [Tool.node, Permission.node, Location.node, Orchestra.node],
})

function harness(directory: string, seen: string[], team: Partial<Orchestra.Interface> = {}) {
  return AppNodeBuilder.build(LayerNode.group([Tool.node, pluginNode, Orchestra.node]), [
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ),
    Permission.node.replace(
      permissionLayer({
        assert: (input) => {
          seen.push(`${input.action}:${input.resources.join(",")}`)
          return Effect.void
        },
      }),
    ),
    // DodTool asks the Orchestrator who holds an item; a tool test has no team.
    Orchestra.node.replace(orchestraLayer(team)),
  ])
}

const run = (tools: Tool.Interface, id: string, input: Record<string, unknown>) =>
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

describe("DodTool", () => {
  it.live("adds, takes, checks and verifies an item through to DONE", () =>
    withTempDir(({ path: directory }) => {
      const seen: string[] = []
      return Effect.gen(function* () {
        const tools = yield* Tool.Service

        const shown = yield* run(tools, "show", { action: "show" })
        expect(text(shown)).toContain("has no DoD")
        expect(seen).toEqual([])

        const added = yield* run(tools, "add", {
          action: "add",
          what: "Greet",
          steps: ["write the greeting"],
          command: "echo hello",
        })
        expect(text(added)).toContain("Added L-001")
        expect(text(added)).toContain("1. [ ] write the greeting")

        yield* run(tools, "take", { action: "take", id: "L-001" })
        const early = yield* run(tools, "verify-early", { action: "verify", id: "L-001" })
        expect(early.error?.message).toContain("1 checklist step(s) remain unchecked")

        const checked = yield* run(tools, "check", { action: "check", id: "L-001", step: "1" })
        expect(text(checked)).toContain("1. [x] write the greeting")

        const verified = yield* run(tools, "verify", { action: "verify", id: "L-001" })
        expect(text(verified)).toContain("L-001 is DONE now")
        expect(seen).toContain("shell:echo hello")
        expect(seen).toContain(`dod:${Dod.FILE}`)

        const file = yield* Effect.promise(() => Bun.file(path.join(directory, Dod.FILE)).text())
        expect(file).toContain("task_state: DONE")
        expect(file).toContain("state: PASSED")
      }).pipe(Effect.provide(harness(directory, seen)))
    }),
  )

  // A project claims its main session too, so being claimed alone must not refuse the
  // Orchestrator; only a claimed session that is not the project's main one may not add.
  it.live("lets the project's main session add an item", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const tools = yield* Tool.Service
        const added = yield* run(tools, "add", { action: "add", what: "Own the board" })
        expect(text(added)).toContain("Added L-001")
      }).pipe(
        Effect.provide(
          harness(directory, [], {
            owners: () => Effect.succeed({ [sessionID]: Orchestra.ProjectID.make("prj_dod") }),
            mainOf: () => Effect.succeed(project("prj_dod")),
          }),
        ),
      ),
    ),
  )

  it.live("refuses an item from a worker session", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const tools = yield* Tool.Service
        // A worker is claimed by its project but is not that project's main session.
        const added = yield* run(tools, "add", { action: "add", what: "Grow the board" })
        expect(added.error?.message).toContain("owned by the project Orchestrator")
      }).pipe(
        Effect.provide(
          harness(directory, [], { owners: () => Effect.succeed({ [sessionID]: Orchestra.ProjectID.make("prj_dod") }) }),
        ),
      ),
    ),
  )

  it.live("lets an unclaimed chat start a board", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const tools = yield* Tool.Service
        const added = yield* run(tools, "add", { action: "add", what: "Start the board" })
        expect(text(added)).toContain("Added L-001")
      }).pipe(Effect.provide(harness(directory, []))),
    ),
  )
})

// The project a claimed session belongs to; only its main session may grow the board.
function project(id: string) {
  return {
    id: Orchestra.ProjectID.make(id),
    name: "DoD",
    directory: "/project",
    created: 1,
  }
}
