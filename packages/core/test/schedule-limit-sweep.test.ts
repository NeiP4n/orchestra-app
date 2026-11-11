import { test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { Global } from "@orchestra/util/global"
import { Database } from "../src/database/database"
import { KV } from "../src/kv"
import { Orchestra } from "../src/orchestra"
import { Location } from "../src/location"
import { SessionExecution } from "../src/session/execution"
import { Trigger } from "../src/trigger"
import { ScheduleView } from "../src/schedule-view"
import { offlineModels } from "./fixture/models"
import { location } from "./fixture/location"
import { AbsolutePath } from "../src/schema"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
test("real sweep persists operator100/hour and100/day across database restart without changing another project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-sweep-proof-"))
  const prior = process.env.ORCHESTRA_DATA_DIR
  process.env.ORCHESTRA_DATA_DIR = path.join(root, "data")
  let wakes = 0
  const idle = makeGlobalNode({
    service: SessionExecution.Service,
    layer: Layer.succeed(
      SessionExecution.Service,
      SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: () => Effect.void,
        wake: () =>
          Effect.sync(() => {
            wakes++
          }),
        interrupt: () => Effect.succeed(false),
        awaitIdle: () => Effect.void,
      }),
    ),
    deps: [],
  })
  const dbfile = path.join(root, "db.sqlite")
  const build = () =>
    AppNodeBuilder.build(LayerNode.group([Database.node, KV.node, Orchestra.node]), [
      Database.node.replace(Database.configured({ path: dbfile })),
      SessionExecution.node.replace(idle),
      Global.node.replace(
        Global.layerWith({
          data: path.join(root, "data"),
          state: path.join(root, "state"),
          config: path.join(root, "config"),
          cache: path.join(root, "cache"),
          tmp: path.join(root, "tmp"),
          bin: path.join(root, "bin"),
          log: path.join(root, "log"),
          repos: path.join(root, "repos"),
        }),
      ),
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(root) }))),
      ),
      offlineModels,
    ])
  let target = "",
    other = "",
    main = ""
  try {
    await mkdir(path.join(root, "project"))
    await mkdir(path.join(root, "other"))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const orchestra = yield* Orchestra.Service,
            kv = yield* KV.Service
          const a = yield* orchestra.create({ name: "A", directory: path.join(root, "project") }),
            b = yield* orchestra.create({ name: "B", directory: path.join(root, "other") })
          main = String(a.main)
          for (const [project, id] of [
            [a, "sweep_target"],
            [b, "sweep_other"],
          ] as const) {
            const made = Trigger.create(
              { kind: "interval", spec: "10080", prompt: "Fixture read only" },
              { id, projectID: String(project.id), now: Date.now(), existing: 0 },
            )
            if (!made.ok) throw Error(made.error)
            yield* kv.set(Trigger.PREFIX + id, made.trigger as never)
            ScheduleView.sync(made.trigger, String(project.main))
          }
          target = Trigger.PREFIX + "sweep_target"
          other = Trigger.PREFIX + "sweep_other"
          ScheduleView.requestHourlyLimit("sweep_target", main, 100)
          ScheduleView.requestDailyLimit("sweep_target", main, 100)
          let row: Trigger.Info | undefined
          for (let i = 0; i < 80; i++) {
            row = Trigger.parse(yield* kv.get(target))
            if (row?.maxPerHour === 100 && row.maxPerDay === 100) break
            yield* Effect.sleep("100 millis")
          }
          if (row?.maxPerHour !== 100 || row.maxPerDay !== 100)
            throw Error("real scheduler failed to apply both requests")
          const foreign = Trigger.parse(yield* kv.get(other))
          if (foreign?.maxPerHour !== 6 || foreign?.maxPerDay !== 48) throw Error("other project changed")
          if (
            ScheduleView.hourlyLimitRequested("sweep_target", main) ||
            ScheduleView.dailyLimitRequested("sweep_target", main)
          )
            throw Error("consumed request remains pending")
          if (ScheduleView.list(main)[0]?.maxPerHour !== 100) throw Error("projection not refreshed")
          expect(row).toMatchObject({ maxPerHour: 100, maxPerDay: 100, publishApproved: false })
        }),
      ).pipe(Effect.provide(build())),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const kv = yield* KV.Service
          const row = Trigger.parse(yield* kv.get(target))
          if (row?.maxPerHour !== 100 || row.maxPerDay !== 100) throw Error("restart lost limits")
          const foreign = Trigger.parse(yield* kv.get(other))
          if (foreign?.maxPerHour !== 6 || foreign.maxPerDay !== 48) throw Error("restart changed other project")
          expect(row).toMatchObject({ maxPerHour: 100, maxPerDay: 100 })
        }),
      ).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Database.node, KV.node]), [
            Database.node.replace(Database.configured({ path: dbfile })),
            Global.node.replace(
              Global.layerWith({
                data: path.join(root, "data"),
                state: path.join(root, "state"),
                config: path.join(root, "config"),
                cache: path.join(root, "cache"),
                tmp: root,
                bin: root,
                log: root,
                repos: root,
              }),
            ),
          ]),
        ),
      ),
    )
    if (wakes !== 0) throw Error("unexpected model wake")
    expect(wakes).toBe(0)
  } finally {
    if (prior === undefined) delete process.env.ORCHESTRA_DATA_DIR
    else process.env.ORCHESTRA_DATA_DIR = prior
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
