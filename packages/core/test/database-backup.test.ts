import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Database as BunDatabase } from "bun:sqlite"
import { Effect } from "effect"
import { Credential } from "@orchestra/core/credential"
import { CredentialEncryption } from "@orchestra/core/credential/encryption"
import { Database } from "@orchestra/core/database/database"
import { DatabaseBackup } from "@orchestra/core/database/backup"
import { DatabaseMigration } from "@orchestra/core/database/migration"
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

  // G2-8 (№44): a corrupt backup must fail the restore BEFORE the live
  // database is touched — the old code deleted the live file first, so a
  // failed copy left nothing at all.
  test("restoring a corrupt backup fails and keeps the live database", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const backup = path.join(tmp.path, "backups", "orchestra-local-backup.db")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run("CREATE TABLE IF NOT EXISTS b8_probe (id TEXT PRIMARY KEY, val TEXT)")
        yield* db.run("INSERT INTO b8_probe VALUES ('1', 'keep-me')")
        yield* DatabaseBackup.backupDatabase(db, backup)
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )

    // Corrupt the backup two ways: garbage, and a truncated real backup
    // whose header still looks like SQLite.
    const garbage = path.join(tmp.path, "backups", "garbage.db")
    writeFileSync(garbage, "not a database at all")
    const truncated = path.join(tmp.path, "backups", "truncated.db")
    writeFileSync(truncated, readFileSync(backup).subarray(0, 100))

    for (const bad of [garbage, truncated]) {
      const result = await Effect.runPromiseExit(DatabaseBackup.restoreDatabase(file, bad))
      expect(result._tag).toBe("Failure")
      expect(existsSync(file)).toBe(true)
      expect(readdirSync(tmp.path).filter((name) => name.includes("pre-restore"))).toEqual([])
    }

    // The live database still opens and still holds the rows.
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

  test("a successful restore leaves no set-aside live copy behind", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const backup = path.join(tmp.path, "backups", "orchestra-local-backup.db")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run("CREATE TABLE IF NOT EXISTS b8_probe (id TEXT PRIMARY KEY, val TEXT)")
        yield* db.run("INSERT INTO b8_probe VALUES ('1', 'keep-me')")
        yield* DatabaseBackup.backupDatabase(db, backup)
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
    writeFileSync(file, "not a database anymore")

    await Effect.runPromise(DatabaseBackup.restoreDatabase(file, backup))
    expect(readdirSync(tmp.path).filter((name) => name.includes("pre-restore"))).toEqual([])
    expect(readdirSync(path.join(tmp.path, "backups")).filter((name) => name.includes("pre-restore"))).toEqual([])
  })

  // G2-8 (№43): rotation deletes only old timestamped backups.
  test("rotation keeps the newest backups and leaves other files alone", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "backups")
    const names = [
      "orchestra-local-2026-11-01T00-00-00-000Z.db",
      "orchestra-local-2026-11-02T00-00-00-000Z.db",
      "orchestra-local-2026-11-03T00-00-00-000Z.db",
      "orchestra-local-2026-11-04T00-00-00-000Z.db",
      "orchestra-local-2026-11-05T00-00-00-000Z.db",
    ]
    await Effect.runPromise(
      Effect.gen(function* () {
        mkdirSync(dir, { recursive: true })
        for (const [index, name] of names.entries()) {
          writeFileSync(path.join(dir, name), `backup ${index}`)
          // Oldest name gets the oldest mtime so rotation follows age, not name.
          utimesSync(path.join(dir, name), new Date(2026, 10, 1 + index), new Date(2026, 10, 1 + index))
        }
        writeFileSync(path.join(dir, "notes.db"), "not a backup")
        writeFileSync(path.join(dir, "orchestra-local.db"), "live database, not a backup")
      }),
    )

    const result = await Effect.runPromise(DatabaseBackup.pruneBackups(dir, 3))
    expect(result.kept.map((entry) => path.basename(entry))).toEqual([
      "orchestra-local-2026-11-05T00-00-00-000Z.db",
      "orchestra-local-2026-11-04T00-00-00-000Z.db",
      "orchestra-local-2026-11-03T00-00-00-000Z.db",
    ])
    expect(result.deleted.map((entry) => path.basename(entry))).toEqual([
      "orchestra-local-2026-11-02T00-00-00-000Z.db",
      "orchestra-local-2026-11-01T00-00-00-000Z.db",
    ])
    expect(existsSync(path.join(dir, "notes.db"))).toBe(true)
    expect(existsSync(path.join(dir, "orchestra-local.db"))).toBe(true)

    const missing = await Effect.runPromise(DatabaseBackup.pruneBackups(path.join(tmp.path, "no-such-dir"), 3))
    expect(missing).toEqual({ kept: [], deleted: [] })
  })

  // G2-8 (№42): one cycle backs up and rotates; databaseFile tells the
  // scheduler which file it is backing up — and stays undefined for :memory:.
  test("a backup cycle snapshots and rotates", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const dir = path.join(tmp.path, "backups")

    const cycle = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run("CREATE TABLE IF NOT EXISTS b8_probe (id TEXT PRIMARY KEY, val TEXT)")
        yield* db.run("INSERT INTO b8_probe VALUES ('1', 'keep-me')")
        expect(yield* DatabaseBackup.databaseFile(db)).toBe(file)
        return yield* DatabaseBackup.runBackupCycle(db, { directory: dir, database: "orchestra-local.db", keep: 7 })
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
    expect(cycle.backup.sizeBytes).toBeGreaterThan(0)
    expect(existsSync(cycle.backup.path)).toBe(true)
    expect(cycle.pruned.deleted).toEqual([])

    // An old fake backup is rotated away by the next cycle with keep: 1.
    const stale = path.join(dir, "orchestra-local-2026-11-01T00-00-00-000Z.db")
    writeFileSync(stale, "stale")
    utimesSync(stale, new Date(2026, 10, 1), new Date(2026, 10, 1))
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* DatabaseBackup.runBackupCycle(db, { directory: dir, database: "orchestra-local.db", keep: 1 })
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
    expect(second.pruned.deleted).toEqual([cycle.backup.path, stale])
    expect(second.pruned.kept).toEqual([second.backup.path])
  })

  test("databaseFile is undefined for an in-memory database", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        expect(yield* DatabaseBackup.databaseFile(db)).toBeUndefined()
      }).pipe(
        Effect.provide(Database.layer({ path: ":memory:" })),
        Effect.provideService(Global.Service, Global.make({ data: "/tmp" })),
        Effect.scoped,
      ),
    )
  })

  // A3-01: the backup is a pair — database + credential key. Losing the data
  // directory must not lose the credentials: restore brings both files back,
  // and the restored key opens the restored sealed rows.
  test("backup writes the credential key next to the database and restore brings the pair back", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const keyFile = path.join(tmp.path, "credential.key")
    const key = CredentialEncryption.createKey()
    writeFileSync(keyFile, key)
    const dir = path.join(tmp.path, "backups")
    const value = Credential.Key.make({ type: "key", key: "fake-test-key-do-not-use-0123456789" })
    const sealed = JSON.stringify(CredentialEncryption.encodeStored(key, value))

    const cycle = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          `INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('cred-1', 'test-integration', 'test', '${sealed}', 0, 0)`,
        )
        return yield* DatabaseBackup.runBackupCycle(db, {
          directory: dir,
          database: "orchestra-local.db",
          keep: 7,
          keyFile,
        })
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
    expect(cycle.backup.keyBackedUp).toBe(true)
    expect(cycle.backup.keyPath).toBe(`${cycle.backup.path}.key`)
    expect(existsSync(cycle.backup.keyPath!)).toBe(true)
    expect(readFileSync(cycle.backup.keyPath!).equals(key)).toBe(true)
    expect(statSync(cycle.backup.keyPath!).mode & 0o777).toBe(0o600)

    // Lose the data directory the way a dead disk would: garbage database, no key.
    writeFileSync(file, "not a database anymore")
    rmSync(keyFile)

    const restored = await Effect.runPromise(
      DatabaseBackup.restoreDatabase(file, cycle.backup.path, { keyFile }),
    )
    expect(restored).toEqual({ database: file, key: "restored" })
    expect(readFileSync(keyFile).equals(key)).toBe(true)
    expect(readdirSync(tmp.path).filter((name) => name.includes("pre-restore"))).toEqual([])

    // The restored key opens the restored sealed row.
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db.all<{ value: unknown }>("SELECT value FROM credential")
        expect(rows).toHaveLength(1)
        // Raw SQL returns the stored JSON text; drizzle's json mode would
        // parse it — parse here the way the credential layer's read does.
        const stored = typeof rows[0]!.value === "string" ? JSON.parse(rows[0]!.value) : rows[0]!.value
        expect(CredentialEncryption.decodeStored(key, stored, "cred-1")).toEqual(value)
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
  })

  // A3-01: a backup that cannot restore the credentials must fail loudly
  // instead of looking complete — and a failed cycle must not rotate away
  // the previous good backup (A3-02: verify first, rotate only on success).
  test("backup refuses when sealed credentials exist but the key file is missing", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const keyFile = path.join(tmp.path, "credential.key")
    const key = CredentialEncryption.createKey()
    writeFileSync(keyFile, key)
    const dir = path.join(tmp.path, "backups")
    const sealed = JSON.stringify(
      CredentialEncryption.encodeStored(key, Credential.Key.make({ type: "key", key: "fake-test-key-do-not-use-0123456789" })),
    )

    const good = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* DatabaseBackup.runBackupCycle(db, {
          directory: dir,
          database: "orchestra-local.db",
          keep: 7,
          keyFile,
        })
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
    expect(good.backup.keyBackedUp).toBe(true)
    expect(existsSync(good.backup.path)).toBe(true)

    // Seal a credential, then lose the key file: the next cycle must fail
    // and leave the previous good backup (database and key) in place.
    rmSync(keyFile)
    const failed = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          `INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('cred-1', 'test-integration', 'test', '${sealed}', 0, 0)`,
        )
        return yield* DatabaseBackup.runBackupCycle(db, {
          directory: dir,
          database: "orchestra-local.db",
          keep: 7,
          keyFile,
        })
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
    expect(failed._tag).toBe("Failure")
    expect(existsSync(good.backup.path)).toBe(true)
    expect(existsSync(`${good.backup.path}.key`)).toBe(true)
    expect(readdirSync(dir).filter((name) => name.endsWith(".db"))).toHaveLength(1)
  })

  // A3-02: the file a backup just wrote must pass quick_check right away —
  // a backup that is only "non-empty" is not a backup.
  test("a backup just written passes verification", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const backup = path.join(tmp.path, "backups", "orchestra-local-backup.db")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run("CREATE TABLE IF NOT EXISTS b8_probe (id TEXT PRIMARY KEY, val TEXT)")
        yield* db.run("INSERT INTO b8_probe VALUES ('1', 'keep-me')")
        const result = yield* DatabaseBackup.backupDatabase(db, backup)
        expect(result.keyBackedUp).toBe(false)
        const check = new BunDatabase(result.path, { readonly: true })
        try {
          expect(check.query("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }])
        } finally {
          check.close()
        }
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
  })

  // A3-01: restoring a backup whose sealed rows no available key opens must
  // fail before the live database and the live key are touched.
  test("restore refuses a backup whose sealed rows no key opens, keeping the live pair", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const keyFile = path.join(tmp.path, "credential.key")
    const key = CredentialEncryption.createKey()
    writeFileSync(keyFile, key)
    const dir = path.join(tmp.path, "backups")
    const sealed = JSON.stringify(
      CredentialEncryption.encodeStored(key, Credential.Key.make({ type: "key", key: "fake-test-key-do-not-use-0123456789" })),
    )

    const cycle = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          `INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('cred-1', 'test-integration', 'test', '${sealed}', 0, 0)`,
        )
        return yield* DatabaseBackup.runBackupCycle(db, {
          directory: dir,
          database: "orchestra-local.db",
          keep: 7,
          keyFile,
        })
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )

    // Case 1: the key sibling is gone and the live key is a different key.
    rmSync(`${cycle.backup.path}.key`)
    const wrongKey = CredentialEncryption.createKey()
    writeFileSync(keyFile, wrongKey)
    const refused = await Effect.runPromiseExit(
      DatabaseBackup.restoreDatabase(file, cycle.backup.path, { keyFile }),
    )
    expect(refused._tag).toBe("Failure")
    expect(readFileSync(keyFile).equals(wrongKey)).toBe(true)
    expect(readdirSync(tmp.path).filter((name) => name.includes("pre-restore"))).toEqual([])
    const live = new BunDatabase(file, { readonly: true })
    try {
      expect(live.query("SELECT COUNT(*) AS n FROM credential").all()).toEqual([{ n: 1 }])
    } finally {
      live.close()
    }

    // Case 2: the key sibling is present but is the wrong key.
    writeFileSync(`${cycle.backup.path}.key`, wrongKey)
    const refused2 = await Effect.runPromiseExit(
      DatabaseBackup.restoreDatabase(file, cycle.backup.path, { keyFile }),
    )
    expect(refused2._tag).toBe("Failure")
    expect(readFileSync(keyFile).equals(wrongKey)).toBe(true)
    expect(readdirSync(tmp.path).filter((name) => name.includes("pre-restore"))).toEqual([])
  })

  // A3-01: when the backup has no key sibling but the live key opens its
  // sealed rows, the restore keeps the live key instead of failing.
  test("restore keeps the live key when it opens the backup sealed rows", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const keyFile = path.join(tmp.path, "credential.key")
    const key = CredentialEncryption.createKey()
    writeFileSync(keyFile, key)
    const dir = path.join(tmp.path, "backups")
    const sealed = JSON.stringify(
      CredentialEncryption.encodeStored(key, Credential.Key.make({ type: "key", key: "fake-test-key-do-not-use-0123456789" })),
    )

    const cycle = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          `INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('cred-1', 'test-integration', 'test', '${sealed}', 0, 0)`,
        )
        return yield* DatabaseBackup.runBackupCycle(db, {
          directory: dir,
          database: "orchestra-local.db",
          keep: 7,
          keyFile,
        })
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
    rmSync(`${cycle.backup.path}.key`)
    writeFileSync(file, "not a database anymore")

    const restored = await Effect.runPromise(
      DatabaseBackup.restoreDatabase(file, cycle.backup.path, { keyFile }),
    )
    expect(restored).toEqual({ database: file, key: "kept-live" })
    expect(readFileSync(keyFile).equals(key)).toBe(true)
  })

  // A3-01: rotation deletes a pruned backup's key sibling with it, and keeps
  // the key siblings of the backups it keeps.
  test("rotation deletes the key sibling of a pruned backup", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "backups")
    mkdirSync(dir, { recursive: true })
    const old = path.join(dir, "orchestra-local-2026-11-01T00-00-00-000Z.db")
    const kept = path.join(dir, "orchestra-local-2026-11-02T00-00-00-000Z.db")
    writeFileSync(old, "old")
    writeFileSync(`${old}.key`, "old-key")
    writeFileSync(kept, "kept")
    writeFileSync(`${kept}.key`, "kept-key")
    utimesSync(old, new Date(2026, 10, 1), new Date(2026, 10, 1))
    utimesSync(kept, new Date(2026, 10, 2), new Date(2026, 10, 2))

    const result = await Effect.runPromise(DatabaseBackup.pruneBackups(dir, 1))
    expect(result.deleted).toEqual([old])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(`${old}.key`)).toBe(false)
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(`${kept}.key`)).toBe(true)
  })

  // G2-8: migrations rewrite schema, so a file database with pending
  // migrations is snapshotted before apply() runs. An empty migration
  // journal means every migration is pending; apply() then refuses the
  // database (tables, no session table) — the backup must already exist.
  test("a file database with pending migrations is backed up before migrating", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const raw = new BunDatabase(file)
    try {
      raw.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
      raw.run("CREATE TABLE probe (x TEXT)")
      raw.run("INSERT INTO probe VALUES ('keep')")
    } finally {
      raw.close()
    }

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* DatabaseMigration.pendingMigrations(db)
      }).pipe(
        Effect.provide(Database.layer({ path: file })),
        Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
        Effect.scoped,
      ),
    )
    // The layer refuses the database, but only after the pre-migration backup.
    expect(exit._tag).toBe("Failure")

    const dir = path.join(tmp.path, "backups")
    const backups = existsSync(dir) ? readdirSync(dir) : []
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/orchestra-local-.*\.db$/)

    // The snapshot holds the pre-migration rows.
    const snapshot = new BunDatabase(path.join(dir, backups[0]!))
    try {
      expect(snapshot.query("SELECT x FROM probe").all()).toEqual([{ x: "keep" }])
    } finally {
      snapshot.close()
    }
  })
})
