import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { FSUtil } from "@orchestra/util/fs-util"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { Database } from "@orchestra/core/database/database"
import { Bus } from "@orchestra/core/bus"
import { Agent } from "@orchestra/core/agent"
import { Job } from "@orchestra/core/job"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import { Config } from "@orchestra/core/config"
import { Document, Info } from "@orchestra/schema/config"
import { ConfigOrchestra } from "@orchestra/schema/config/orchestra"
import { Orchestra } from "@orchestra/core/orchestra"
import { Federation } from "@orchestra/core/federation"
import { Session } from "@orchestra/core/session"
import { SessionExecution } from "@orchestra/core/session/execution"
import { KV } from "@orchestra/core/kv"
import { Location } from "@orchestra/core/location"
import { AbsolutePath } from "@orchestra/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

// B10: the Society's base projects live in the operator's config, not in
// code. These tests prove the config actually wins — and that a broken entry
// falls back to the built-in four instead of founding a half crew.

// Main sessions are never run here: the tests read what federation put in their inboxes.
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

const societyDocument = (baseProjects: ReadonlyArray<ConfigOrchestra.BaseProject>) =>
  new Document({
    type: "document",
    info: new Info({
      orchestra: new ConfigOrchestra.Info({
        society: new ConfigOrchestra.Society({ baseProjects: [...baseProjects] }),
      }),
    }),
  })

const makeIt = (entries: ReadonlyArray<Document>) =>
  testEffect(
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
        FSUtil.node,
        Config.node,
      ]),
      [
        SessionExecution.node.replace(idleExecution),
        Global.node.replace(tempGlobalLayer),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
        ),
        Config.node.replace(Config.testLayer([...entries])),
        offlineModels,
      ],
    ),
  )

const custom = [
  new ConfigOrchestra.BaseProject({
    key: "lead",
    folder: "lead",
    name: "Lead",
    role: "strategic-planner",
    brief: "Lead the crew.",
  }),
  new ConfigOrchestra.BaseProject({
    key: "builders",
    folder: "builders",
    name: "Builders",
    role: "developer",
    brief: "Build it.",
  }),
]

const broken = [
  new ConfigOrchestra.BaseProject({
    key: "lead",
    folder: "lead",
    name: "Lead",
    role: "strategic-planner",
    brief: "Lead the crew.",
  }),
  // A missing brief: the whole configured list is refused, not half applied.
  new ConfigOrchestra.BaseProject({ key: "builders", folder: "builders", name: "Builders", role: "developer", brief: "" }),
]

describe("Federation baseProjects from config", () => {
  const itCustom = makeIt([societyDocument(custom)])
  itCustom.live("baseProjects comes from the operator's config when it is set", () =>
    Effect.gen(function* () {
      const federation = yield* Federation.Service
      expect((yield* federation.baseProjects()).map((item) => item.key)).toEqual(["lead", "builders"])
    }),
  )

  itCustom.live("createSociety founds from the configured planner", () =>
    Effect.gen(function* () {
      const federation = yield* Federation.Service
      const root = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-society-config-")))
      const society = yield* federation.createSociety({ goal: "Build from config", name: "ConfigCrew", directory: root.path })
      expect(society.project.name).toBe("Lead")
      expect(society.directory).toContain("configcrew")
      expect(society.project.directory).toContain("lead")
    }),
    60_000,
  )

  const itBroken = makeIt([societyDocument(broken)])
  itBroken.live("a broken configured entry falls back to the built-in four", () =>
    Effect.gen(function* () {
      const federation = yield* Federation.Service
      expect((yield* federation.baseProjects()).map((item) => item.key)).toEqual([
        "planner",
        "architects",
        "coders",
        "testers",
      ])
    }),
  )
})
