import { describe, expect, test } from "bun:test"
import { chmod, stat, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import path from "path"
import { Database as BunDatabase } from "bun:sqlite"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@orchestra/core/database/database"
import { Global } from "@orchestra/util/global"
import { tmpdir } from "./fixture/tmpdir"

// Read while the connection is open: SQLite may remove the sidecars on close.
const openModes = (filename: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Layer.build(Database.layer({ path: filename }))
      return yield* Effect.promise(() =>
        Promise.all(["", "-wal", "-shm"].map(async (suffix) => (await stat(filename + suffix)).mode & 0o777)),
      )
    }).pipe(Effect.scoped, Effect.provideService(Global.Service, Global.make({ data: path.dirname(filename) }))),
  )

describe.skipIf(process.platform === "win32")("Database file permissions", () => {
  test("creates the database and sidecars readable only by the owner", async () => {
    await using tmp = await tmpdir()

    expect(await openModes(path.join(tmp.path, "opencode.db"))).toEqual([0o600, 0o600, 0o600])
  })

  test("tightens an existing database and sidecars", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "opencode.db")
    await Promise.all(
      ["", "-wal", "-shm"].map(async (suffix) => {
        await writeFile(filename + suffix, "")
        await chmod(filename + suffix, 0o644)
      }),
    )

    expect(await openModes(filename)).toEqual([0o600, 0o600, 0o600])
  })
})

describe("Database legacy WAL migration", () => {
  test("checkpoints active WAL before copying legacy database", async () => {
    await using tmp = await tmpdir()
    const legacyPath = path.join(tmp.path, "opencode-local.db")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run("CREATE TABLE IF NOT EXISTS test_migration (id TEXT PRIMARY KEY, val TEXT)")
        yield* db.run("INSERT INTO test_migration VALUES ('1', 'wal_migrated')")
      }).pipe(
        Effect.provide(Database.layer({ path: legacyPath })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )

    const legacyDb = new BunDatabase(legacyPath)
    legacyDb.run("PRAGMA journal_mode = WAL;")
    legacyDb.run("INSERT INTO test_migration VALUES ('2', 'uncheckpointed_wal');")
    legacyDb.close()

    const orchestraPath = path.join(tmp.path, "orchestra-local.db")
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db.all<{ id: string; val: string }>("SELECT * FROM test_migration ORDER BY id")
        expect(rows).toEqual([
          { id: "1", val: "wal_migrated" },
          { id: "2", val: "uncheckpointed_wal" },
        ])
      }).pipe(
        Effect.provide(Database.layer({ path: orchestraPath })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )

    expect(existsSync(orchestraPath)).toBe(true)
  })
})

describe("Database crash recovery", () => {
  test("a row committed in WAL survives the process dying without closing the database", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")

    // A first clean boot builds the full schema, so the crash below happens
    // against a real, fully migrated database.
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run("CREATE TABLE crash_probe (id TEXT PRIMARY KEY, val TEXT)")
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )

    // A child process commits a row and exits without closing the database:
    // the -wal sidecar is left uncheckpointed, exactly like a kill -9.
    const script = path.join(tmp.path, "crash-child.js")
    await writeFile(
      script,
      `const { Database } = require("bun:sqlite")
const db = new Database(${JSON.stringify(file)})
db.run("INSERT INTO crash_probe VALUES ('1', 'committed_before_crash')")
process.exit(0)
`,
    )
    const child = Bun.spawnSync({ cmd: [process.execPath, script], stdout: "pipe", stderr: "pipe" })
    expect(child.exitCode).toBe(0)

    // The layer must recover the committed row from the leftover WAL.
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db.all<{ id: string; val: string }>("SELECT * FROM crash_probe")
        expect(rows).toEqual([{ id: "1", val: "committed_before_crash" }])
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
  })

  test("a truncated database file fails the boot with restore instructions", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")

    // A real database, then truncated: the header survives, the pages do
    // not — what an interrupted copy or a disk-full write leaves behind.
    const seed = new BunDatabase(file)
    seed.run("CREATE TABLE probe (id TEXT PRIMARY KEY)")
    seed.close()
    const bytes = readFileSync(file)
    await writeFile(file, bytes.subarray(0, 128))

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* Layer.build(Database.layer({ path: file }))
      }).pipe(Effect.scoped, Effect.provideService(Global.Service, Global.make({ data: tmp.path }))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const text = Cause.pretty(exit.cause)
      expect(text).toContain("orchestra db restore")
      expect(text).toContain(path.join(tmp.path, "backups"))
    }

    // The corrupt file is left untouched for the operator to salvage.
    expect(readFileSync(file).length).toBe(128)
  })
})
