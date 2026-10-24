import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ConfigOrchestra } from "@orchestra/schema/config/orchestra"
import { Document, Info } from "@orchestra/schema/config"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { makeGlobalNode, makeLocationNode } from "@orchestra/util/effect/app-node"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Database } from "@orchestra/core/database/database"
import { Bus } from "@orchestra/core/bus"
import { Agent } from "@orchestra/core/agent"
import { Config } from "@orchestra/core/config"
import { Job } from "@orchestra/core/job"
import { KV } from "@orchestra/core/kv"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import { Location } from "@orchestra/core/location"
import { Model } from "@orchestra/core/model"
import { Orchestra } from "@orchestra/core/orchestra"
import { Federation } from "@orchestra/core/federation"
import { Form } from "@orchestra/core/form"
import { Permission } from "@orchestra/core/permission"
import { Session } from "@orchestra/core/session"
import { SessionExecution } from "@orchestra/core/session/execution"
import { Tool } from "@orchestra/core/tool"
import { OrchestraTool } from "@orchestra/core/tool/plugin/orchestra"
import { WorkspaceForgeTool } from "@orchestra/core/tool/plugin/workspace-forge"
import { AbsolutePath } from "@orchestra/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { permissionLayer } from "./lib/permission"

// Neither tool runs a session here; creation only, so every execution stays idle.
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
  name: "test/worker-policy-tools",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      yield* registerToolPlugin(WorkspaceForgeTool.Plugin)
      yield* registerToolPlugin(OrchestraTool.Plugin)
    }),
  ),
  deps: [Tool.node, Orchestra.node, Federation.node, Permission.node, Database.node, Session.node, Form.node],
})

const harness = (worker?: ConfigOrchestra.Worker) =>
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
      Form.node,
      Tool.node,
      Config.node,
      pluginNode,
    ]),
    [
      SessionExecution.node.replace(idleExecution),
      Global.node.replace(tempGlobalLayer),
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ),
      Permission.node.replace(
        permissionLayer({ assert: () => Effect.void, confirm: () => Effect.void }),
      ),
      offlineModels,
      Config.node.replace(
        Config.testLayer(
          worker === undefined
            ? []
            : [
                new Document({
                  type: "document",
                  info: new Info({ orchestra: new ConfigOrchestra.Info({ worker }) }),
                }),
              ],
        ),
      ),
    ],
  )

const selection = (value: string) => {
  const ref = Model.Ref.parse(value)
  return {
    providerID: ref.providerID,
    model: ref.id,
    ...(ref.variant === undefined ? {} : { variant: ref.variant }),
  }
}

const policy = new ConfigOrchestra.Worker({
  model: selection("opencode/big-pickle"),
  categories: {
    Build: new ConfigOrchestra.Policy({ model: selection("zen/glm-4.6") }),
  },
})

const itPolicy = testEffect(harness(policy))
const itPlain = testEffect(harness())

const mainModel = Model.Ref.parse("opencode/main-model")

const setup = Effect.gen(function* () {
  const orchestra = yield* Orchestra.Service
  const sessions = yield* Session.Service
  const root = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-worker-policy-")))
  const main = yield* orchestra.create({ name: "Command", directory: root.path })
  // The operator picked this model for the Orchestrator; it is what a worker inherits.
  yield* sessions.switchModel({ sessionID: main.main!, model: mainModel })
  const member = (name: string) => path.join(root.path, name)
  return { orchestra, sessions, root, main, member }
})

const memberDirectory = (member: (name: string) => string, name: string) =>
  Effect.gen(function* () {
    const directory = member(name)
    yield* Effect.promise(() => mkdir(directory, { recursive: true }))
    // Members must hold files: an empty directory is rejected as a wrong path.
    yield* Effect.promise(() => writeFile(path.join(directory, "README.md"), name))
    return directory
  })

const runTool = (
  tools: Tool.Interface,
  sessionID: Session.ID,
  name: string,
  id: string,
  input: Record<string, unknown>,
) =>
  executeTool(tools, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call" as const, id, name, input },
  })

const text = (result: { readonly content?: ReadonlyArray<Tool.Content>; readonly error?: unknown }) => {
  const output = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
  if (!output) throw new Error(`tool failed: ${JSON.stringify(result.error)}`)
  return output
}

const workerByDirectory = (orchestra: Orchestra.Interface, directory: string) =>
  Effect.gen(function* () {
    const project = (yield* orchestra.projects()).find((item) => item.directory === directory)
    if (!project) throw new Error(`no project was created at ${directory}`)
    const workers = yield* orchestra.sessions(project.id)
    expect(workers).toHaveLength(1)
    return workers[0]!
  })

describe("orchestra.worker policy through workspace_forge", () => {
  itPolicy.live("gives a Build role its category model and another category the worker model", () =>
    Effect.gen(function* () {
      const { main, member } = yield* setup
      const tools = yield* Tool.Service
      const orchestra = yield* Orchestra.Service

      const build = yield* memberDirectory(member, "build")
      yield* runTool(tools, main.main!, WorkspaceForgeTool.name, "create-build", {
        action: "create_session",
        directory: build,
        sandbox: "none",
        role: "developer",
      })
      const developer = yield* workerByDirectory(orchestra, build)
      expect(developer.model).toMatchObject({ providerID: "zen", id: "glm-4.6" })

      const planning = yield* memberDirectory(member, "planning")
      yield* runTool(tools, main.main!, WorkspaceForgeTool.name, "create-planning", {
        action: "create_session",
        directory: planning,
        sandbox: "none",
        role: "architect",
      })
      const architect = yield* workerByDirectory(orchestra, planning)
      expect(architect.model).toMatchObject({ providerID: "opencode", id: "big-pickle" })
    }),
  )

  itPolicy.live("still creates the worker when a saved role carries an unparseable model string", () =>
    Effect.gen(function* () {
      const { main, member } = yield* setup
      const tools = yield* Tool.Service
      const orchestra = yield* Orchestra.Service
      const kv = yield* KV.Service

      const role = yield* orchestra.saveRole(undefined, {
        name: "Legacy",
        description: "Role saved before model strings were validated",
        rules: "Work.",
        category: "Data",
        readOnly: false,
        models: ["opencode/minimax-free"],
      })
      // A role stored by an older build may hold an entry that no longer parses. Worker creation
      // must skip it instead of failing the whole session.
      yield* kv.set(`orchestra/role/${role.id}`, {
        name: role.name,
        description: role.description,
        rules: role.rules,
        category: role.category,
        readOnly: role.readOnly,
        models: ["not-a-model"],
        created: Date.now(),
      })

      const directory = yield* memberDirectory(member, "legacy")
      const created = text(
        yield* runTool(tools, main.main!, WorkspaceForgeTool.name, "create-legacy", {
          action: "create_session",
          directory,
          sandbox: "none",
          role: role.id,
        }),
      )
      expect(created).toContain("worker session")
      const worker = yield* workerByDirectory(orchestra, directory)
      expect(worker.model).toMatchObject({ providerID: "opencode", id: "big-pickle" })
    }),
  )

  itPolicy.live("lets an explicit task model win over the worker policy", () =>
    Effect.gen(function* () {
      const { main, sessions, orchestra } = yield* setup
      const tools = yield* Tool.Service

      const role = yield* orchestra.saveRole(undefined, {
        name: "Task Model Role",
        description: "A role that allows an automatic model choice",
        rules: "Work.",
        category: "Build",
        readOnly: false,
        models: ["opencode/task-model"],
      })

      const output = text(
        yield* runTool(tools, main.main!, OrchestraTool.name, "create-task", {
          action: "create",
          role: role.id,
          model: "opencode/task-model",
          newInstance: true,
        }),
      )
      const sessionID = /Created (ses_[A-Za-z0-9]+)/.exec(output)?.[1]
      expect(sessionID).toBeDefined()
      const worker = yield* sessions.get(Session.ID.make(sessionID!))
      expect(worker.model).toMatchObject({ providerID: "opencode", id: "task-model" })
    }),
  )
})

describe("orchestra.worker policy without configuration", () => {
  itPlain.live("keeps the previous behaviour: a new worker inherits the main session model", () =>
    Effect.gen(function* () {
      const { main, sessions, orchestra } = yield* setup
      const tools = yield* Tool.Service
      const role = (yield* orchestra.roles()).find((item) => item.id === "developer")!

      yield* runTool(tools, main.main!, OrchestraTool.name, "create-developer", {
        action: "create",
        role: role.id,
        newInstance: true,
      })

      const workers = yield* orchestra.sessions((yield* orchestra.projects())[0]!.id)
      expect(workers).toHaveLength(1)
      expect(workers[0]!.model).toMatchObject({ providerID: "opencode", id: "main-model" })
      expect(yield* sessions.get(workers[0]!.id)).toMatchObject({
        model: { providerID: "opencode", id: "main-model" },
      })
    }),
  )
})
