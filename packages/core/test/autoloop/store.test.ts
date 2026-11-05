import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Stream } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@orchestra/core/database/database"
import autoloopMigration from "@orchestra/core/database/migration/20261105171218_oval_joystick"
import { AutoloopEvolve } from "@orchestra/core/autoloop/kernel/evolve"
import { AutoloopStore } from "@orchestra/core/autoloop/kernel/store"
import { AutoloopSchema } from "@orchestra/core/autoloop/kernel/schema"
import type { AutoloopFact } from "@orchestra/core/autoloop/kernel/schema"
import { Global } from "@orchestra/util/global"

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Database.layer({ path: ":memory:" })),
      Effect.provideService(Global.Service, Global.make({ data: path.join(process.cwd(), ".test-data") })),
      Effect.scoped,
    ),
  )

const queued = (id: string, key: string): AutoloopFact => ({
  id,
  type: "run.queued",
  collection: "runs",
  key,
  data: { state: "queued" },
})

describe("AutoloopStore", () => {
  test("bootstraps the autoloop tables and records the migration", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const tables = yield* db.all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'autoloop_%' ORDER BY name`,
        )
        expect(tables).toEqual([
          { name: "autoloop_facts" },
          { name: "autoloop_projection_meta" },
          { name: "autoloop_projection_refs" },
          { name: "autoloop_projections" },
        ])
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${autoloopMigration.id}`)).toEqual({
          id: autoloopMigration.id,
        })
      }),
    )
  })

  test("commit writes a fact and updates the projection", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const result = yield* AutoloopStore.commitLatest([queued("f1", "run_1")])

        expect(result.seqs).toEqual([1])
        expect(result.lastSeq).toBe(1)
        expect(result.view).toEqual({ runs: { run_1: { state: "queued" } } })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM autoloop_facts`)).toEqual({ count: 1 })
        expect(yield* db.get(sql`SELECT collection, key, data FROM autoloop_projections`)).toEqual({
          collection: "runs",
          key: "run_1",
          data: JSON.stringify({ state: "queued" }),
        })
        expect(yield* db.get(sql`SELECT value FROM autoloop_projection_meta WHERE key = 'last_seq'`)).toEqual({
          value: "1",
        })
      }),
    )
  })

  test("rebuild from the journal restores the same state as the stored projections", async () => {
    await run(
      Effect.gen(function* () {
        yield* AutoloopStore.commitLatest([queued("f1", "run_1"), queued("f2", "run_2")])
        yield* AutoloopStore.commitLatest([
          { id: "f3", type: "run.done", collection: "runs", key: "run_1", data: { state: "done" } },
          { id: "f4", type: "run.cancelled", collection: "runs", key: "run_2", data: null },
          { id: "f5", type: "test.note" },
        ])

        const log = yield* AutoloopStore.readLog()
        const opened = yield* AutoloopStore.openView()

        expect(log.map((fact) => fact.id)).toEqual(["f1", "f2", "f3", "f4", "f5"])
        expect(opened.lastSeq).toBe(5)
        expect(AutoloopEvolve.rebuild(log)).toEqual(opened.view)
        expect(opened.view).toEqual({ runs: { run_1: { state: "done" } } })
      }),
    )
  })

  test("commit on a stale seq fails and writes nothing", async () => {
    await run(
      Effect.gen(function* () {
        yield* AutoloopStore.commitLatest([queued("f1", "run_1")])

        const error = yield* AutoloopStore.commit([queued("f2", "run_2")], 0).pipe(Effect.flip)
        expect(error).toBeInstanceOf(AutoloopStore.StaleSeqError)
        expect(error as AutoloopStore.StaleSeqError).toMatchObject({ expected: 0, actual: 1 })

        // No half-written fact and no projection from the rejected commit.
        expect(yield* AutoloopStore.readLog()).toHaveLength(1)
        expect((yield* AutoloopStore.openView()).view).toEqual({ runs: { run_1: { state: "queued" } } })
      }),
    )
  })

  test("commitLatest assigns consecutive sequences across commits", async () => {
    await run(
      Effect.gen(function* () {
        const first = yield* AutoloopStore.commitLatest([queued("f1", "run_1")])
        const second = yield* AutoloopStore.commitLatest([queued("f2", "run_2"), queued("f3", "run_3")])

        expect(first.seqs).toEqual([1])
        expect(second.seqs).toEqual([2, 3])
        expect(second.lastSeq).toBe(3)
      }),
    )
  })

  test("a fact with data null deletes the projection row and its refs", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* AutoloopStore.commitLatest([
          {
            id: "f1",
            type: "run.queued",
            collection: "runs",
            key: "run_1",
            data: { state: "queued" },
            refs: [{ collection: "events", key: "evt_1" }],
          },
        ])
        expect(yield* db.all(sql`SELECT ref_collection, ref_key FROM autoloop_projection_refs`)).toEqual([
          { ref_collection: "events", ref_key: "evt_1" },
        ])

        yield* AutoloopStore.commitLatest([
          { id: "f2", type: "run.cancelled", collection: "runs", key: "run_1", data: null },
        ])

        expect((yield* AutoloopStore.openView()).view).toEqual({})
        expect(yield* db.all(sql`SELECT collection FROM autoloop_projections`)).toEqual([])
        expect(yield* db.all(sql`SELECT collection FROM autoloop_projection_refs`)).toEqual([])
      }),
    )
  })

  test("journal-only facts are recorded but change no projection", async () => {
    await run(
      Effect.gen(function* () {
        const result = yield* AutoloopStore.commitLatest([{ id: "f1", type: "test.note", data: { note: "hi" } }])

        expect(result.lastSeq).toBe(1)
        expect(result.view).toEqual({})
        expect(yield* AutoloopStore.readLog()).toHaveLength(1)
      }),
    )
  })

  test("iterateLog streams the journal in order", async () => {
    await run(
      Effect.gen(function* () {
        yield* AutoloopStore.commitLatest([queued("f1", "run_1"), queued("f2", "run_2")])
        const facts = yield* AutoloopStore.iterateLog().pipe(Stream.runCollect)

        expect(facts.map((fact) => fact.id)).toEqual(["f1", "f2"])
      }),
    )
  })

  test("rebuildProjections rewrites the projections from the journal", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* AutoloopStore.commitLatest([queued("f1", "run_1"), queued("f2", "run_2")])
        yield* AutoloopStore.commitLatest([
          { id: "f3", type: "run.done", collection: "runs", key: "run_1", data: { state: "done" } },
        ])
        // Simulate projections folded by older kernel code: wipe them and lie about the format.
        yield* db.run(sql`DELETE FROM autoloop_projections`)
        yield* db.run(sql`DELETE FROM autoloop_projection_refs`)
        yield* db.run(sql`UPDATE autoloop_projection_meta SET value = 'autoloop-kernel-v0' WHERE key = 'format'`)

        const rebuilt = yield* AutoloopStore.rebuildProjections()
        const opened = yield* AutoloopStore.openView()
        const log = yield* AutoloopStore.readLog()

        expect(rebuilt.view).toEqual(AutoloopEvolve.rebuild(log))
        expect(rebuilt.lastSeq).toBe(3)
        expect(opened.view).toEqual({
          runs: { run_1: { state: "done" }, run_2: { state: "queued" } },
        })
        expect(opened.lastSeq).toBe(3)
        expect(opened.format).toBe(AutoloopSchema.FORMAT)
      }),
    )
  })
})
