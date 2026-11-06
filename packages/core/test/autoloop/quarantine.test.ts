import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@orchestra/core/database/database"
import { AutoloopStore } from "@orchestra/core/autoloop/kernel/store"
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

const done = (id: string, key: string): AutoloopFact => ({
  id,
  type: "run.done",
  collection: "runs",
  key,
  data: { state: "done" },
})

describe("AutoloopStore quarantine", () => {
  test("quarantine removes a fact's effect from the view but keeps it in the journal", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* AutoloopStore.commitLatest([queued("f1", "run_1"), done("f2", "run_1")])
        const before = yield* AutoloopStore.openView()
        expect(before.view).toEqual({ runs: { run_1: { state: "done" } } })

        // The "done" fact is poisoned: quarantine it, and the run falls back
        // to "queued" — the earlier fact still folds.
        const result = yield* AutoloopStore.quarantine(2, "poisoned: run never finished")
        expect(result.changed).toBe(true)
        expect(result.view).toEqual({ runs: { run_1: { state: "queued" } } })
        const after = yield* AutoloopStore.openView()
        expect(after.view).toEqual({ runs: { run_1: { state: "queued" } } })

        // The journal keeps the fact as evidence.
        expect(yield* AutoloopStore.readLog()).toHaveLength(2)
        expect(yield* db.get(sql`SELECT count(*) AS count FROM autoloop_facts`)).toEqual({ count: 2 })
        const listed = yield* AutoloopStore.listQuarantine()
        expect(listed).toEqual([{ seq: 2, reason: "poisoned: run never finished", at: expect.any(Number) }])

        // A rebuild does not replay the quarantined fact.
        const rebuilt = yield* AutoloopStore.rebuildProjections()
        expect(rebuilt.view).toEqual({ runs: { run_1: { state: "queued" } } })
      }),
    )
  })

  test("quarantining twice is a no-op the second time, and unquarantine brings the fact back", async () => {
    await run(
      Effect.gen(function* () {
        yield* AutoloopStore.commitLatest([queued("f1", "run_1"), done("f2", "run_1")])
        const first = yield* AutoloopStore.quarantine(2, "poisoned")
        expect(first.changed).toBe(true)
        const second = yield* AutoloopStore.quarantine(2, "poisoned again")
        expect(second.changed).toBe(false)
        expect(second.view).toEqual({ runs: { run_1: { state: "queued" } } })
        expect(yield* AutoloopStore.listQuarantine()).toHaveLength(1)

        const lifted = yield* AutoloopStore.unquarantine(2)
        expect(lifted.changed).toBe(true)
        expect(lifted.view).toEqual({ runs: { run_1: { state: "done" } } })
        expect(yield* AutoloopStore.listQuarantine()).toEqual([])
        const again = yield* AutoloopStore.unquarantine(2)
        expect(again.changed).toBe(false)
      }),
    )
  })

  test("quarantining a sequence with no fact fails and changes nothing", async () => {
    await run(
      Effect.gen(function* () {
        yield* AutoloopStore.commitLatest([queued("f1", "run_1")])
        const result = yield* Effect.exit(AutoloopStore.quarantine(99, "no such fact"))
        expect(result._tag).toBe("Failure")
        expect(yield* AutoloopStore.listQuarantine()).toEqual([])
        const opened = yield* AutoloopStore.openView()
        expect(opened.view).toEqual({ runs: { run_1: { state: "queued" } } })
      }),
    )
  })
})
