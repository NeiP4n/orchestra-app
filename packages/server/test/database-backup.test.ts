import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { Effect, Schedule } from "effect"
import { Database } from "@orchestra/core/database/database"
import { Global } from "@orchestra/util/global"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { ServerDatabaseBackup } from "../src/database-backup"

// G2-8 (№42): the server backs its live database up on a schedule — one
// cycle at startup, then one every interval. These tests run the cycle and
// the scheduler loop against throwaway file databases only, never the live one.
const withDb = <A, E>(file: string, data: string, program: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(Database.layer({ path: file })),
      Effect.provideService(Global.Service, Global.make({ data })),
      Effect.scoped,
    ),
  )

const waitForBackup = (dir: string) =>
  Effect.gen(function* () {
    if (!existsSync(dir) || readdirSync(dir).length === 0)
      return yield* Effect.fail(new Error(`no backup in ${dir} yet`))
  }).pipe(Effect.retry(Schedule.spaced("10 millis")), Effect.timeout("5 seconds"))

describe("ServerDatabaseBackup", () => {
  test("runCycle snapshots a file database into <data>/backups by default", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const dir = path.join(tmp.path, "backups")

    const backup = await withDb(
      file,
      tmp.path,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run("CREATE TABLE IF NOT EXISTS b8_probe (id TEXT PRIMARY KEY, val TEXT)")
        yield* db.run("INSERT INTO b8_probe VALUES ('1', 'keep-me')")
        return yield* ServerDatabaseBackup.runCycle(db, Global.make({ data: tmp.path }))
      }),
    )
    expect(backup).toBeDefined()
    expect(backup?.startsWith(dir)).toBe(true)
    expect(existsSync(backup!)).toBe(true)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  test("runCycle skips an in-memory database", async () => {
    await using tmp = await tmpdir()
    const backup = await withDb(
      ":memory:",
      tmp.path,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* ServerDatabaseBackup.runCycle(db, Global.make({ data: tmp.path }))
      }),
    )
    expect(backup).toBeUndefined()
    expect(existsSync(path.join(tmp.path, "backups"))).toBe(false)
  })

  test("start backs up immediately, and disabled start backs up nothing", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const dir = path.join(tmp.path, "backups")

    await withDb(
      file,
      tmp.path,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const global = Global.make({ data: tmp.path })
        yield* ServerDatabaseBackup.start(db, global, { enabled: false, directory: dir })
        yield* Effect.sleep("100 millis")
        expect(existsSync(dir)).toBe(false)

        yield* ServerDatabaseBackup.start(db, global, { directory: dir, intervalHours: 24 })
        yield* waitForBackup(dir)
        expect(readdirSync(dir)).toHaveLength(1)
      }),
    )
  })
})
