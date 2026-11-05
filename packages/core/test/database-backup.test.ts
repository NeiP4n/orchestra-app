import { describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@orchestra/core/database/database"
import { DatabaseBackup } from "@orchestra/core/database/backup"
import { Global } from "@orchestra/util/global"
import { tmpdir } from "./fixture/tmpdir"

describe("Database backup and restore", () => {
  test("backup survives a destroyed database file and restores it", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const backup = path.join(tmp.path, "backups", "orchestra-local-backup.db")

    // Write rows, then back the database up while it is open.
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run("CREATE TABLE IF NOT EXISTS b8_probe (id TEXT PRIMARY KEY, val TEXT)")
        yield* db.run("INSERT INTO b8_probe VALUES ('1', 'keep-me')")
        const result = yield* DatabaseBackup.backupDatabase(db, backup)
        expect(result.path).toBe(backup)
        expect(result.sizeBytes).toBeGreaterThan(0)
        expect(existsSync(backup)).toBe(true)
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )

    // Destroy the live file the way a power failure would: garbage, no WAL.
    writeFileSync(file, "not a database anymore")
    for (const suffix of ["-wal", "-shm"]) if (existsSync(file + suffix)) writeFileSync(file + suffix, "")

    await Effect.runPromise(DatabaseBackup.restoreDatabase(file, backup))
    expect(existsSync(file)).toBe(true)

    // The restored database opens and still holds the rows.
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db.all<{ id: string; val: string }>("SELECT * FROM b8_probe ORDER BY id")
        expect(rows).toEqual([{ id: "1", val: "keep-me" }])
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
  })

  test("restoring a missing backup fails instead of wiping the database", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    writeFileSync(file, "live data")

    const result = await Effect.runPromiseExit(
      DatabaseBackup.restoreDatabase(file, path.join(tmp.path, "no-such-backup.db")),
    )
    expect(result._tag).toBe("Failure")
    expect(existsSync(file)).toBe(true)
  })

  test("backup names are timestamped and sortable", () => {
    const first = DatabaseBackup.timestampedBackupPath("/backups", "orchestra-local.db")
    expect(first.startsWith("/backups/orchestra-local-")).toBe(true)
    expect(first.endsWith(".db")).toBe(true)
    expect(first).not.toContain(":")
  })
})
