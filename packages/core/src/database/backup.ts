export * as DatabaseBackup from "./backup.js"

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { checkpointWal, verifyDatabaseFile } from "#sqlite"
import { Database } from "./database.js"

type Handle = Database.Interface["db"]

export interface BackupResult {
  readonly path: string
  readonly sizeBytes: number
}

// Only files the backup cycle itself wrote are ever pruned: a timestamped
// `orchestra-local-2026-11-05T23-00-00-000Z.db` name. Anything else in the
// directory — a hand-made copy, a pre-restore aside — is left alone.
export const BACKUP_FILE_PATTERN = /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/

// VACUUM INTO takes the destination as a string literal, never a bound
// parameter: escape embedded quotes and reject NUL bytes instead of trusting
// the caller with raw SQL.
const literal = (value: string) => {
  if (value.includes("\0")) throw new Error("Backup path must not contain NUL")
  return `'${value.replaceAll("'", "''")}'`
}

const backupFile = (database: string) =>
  `${path.basename(database).replace(/\.db$/, "")}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`

/** Timestamped backup file name inside a directory, e.g. `orchestra-local-2026-11-05T23-00-00-000Z.db`. */
export const timestampedBackupPath = (directory: string, database: string) =>
  path.join(directory, backupFile(database))

/** File path of the database behind a live handle, or `undefined` for an in-memory database. */
export const databaseFile = Effect.fn("DatabaseBackup.databaseFile")(function* (db: Handle) {
  const rows = yield* db
    .all<{ seq: number; name: string; file: string }>("PRAGMA database_list")
    .pipe(Effect.orDie)
  const file = rows.find((row) => row.name === "main")?.file
  return file === undefined || file === "" ? undefined : file
})

/**
 * Copy the live database to `destination` as one consistent snapshot
 * (`VACUUM INTO` reads the database including its WAL, so the backup never
 * catches the file mid-write). Overwrites an existing file at the destination.
 * Call this before any destructive work and before the first live Society run:
 * without a backup, one power failure is the loss of every project, session
 * and journal fact.
 */
export const backupDatabase = Effect.fn("DatabaseBackup.backup")(function* (db: Handle, destination: string) {
  const file = path.resolve(destination)
  yield* Effect.try({
    try: () => mkdirSync(path.dirname(file), { recursive: true }),
    catch: (cause) => new Error(`Cannot create backup directory ${path.dirname(file)}: ${String(cause)}`),
  })
  if (existsSync(file)) rmSync(file)
  yield* db.run(`VACUUM INTO ${literal(file)}`).pipe(Effect.orDie)
  const sizeBytes = yield* Effect.try({
    try: () => statSync(file).size,
    catch: (cause) => new Error(`Backup produced no file at ${file}: ${String(cause)}`),
  })
  if (process.platform !== "win32") {
    // Backups hold the same credentials as the live database: same owner-only mode.
    yield* Effect.promise(() => chmod(file, 0o600))
  }
  return { path: file, sizeBytes } satisfies BackupResult
})

export interface PruneResult {
  readonly kept: ReadonlyArray<string>
  readonly deleted: ReadonlyArray<string>
}

/**
 * G2-8 (№43): keep the `keep` newest timestamped backups in `directory` and
 * delete the older ones. Only files matching the timestamped backup name are
 * touched; a missing directory prunes nothing. Newest-first by modification
 * time, ties broken by name so the result is deterministic.
 */
export const pruneBackups = Effect.fn("DatabaseBackup.prune")(function* (directory: string, keep = 7) {
  const dir = path.resolve(directory)
  if (!existsSync(dir)) return { kept: [], deleted: [] } satisfies PruneResult
  const count = Math.max(0, Math.floor(keep))
  const entries = yield* Effect.try({
    try: () =>
      readdirSync(dir)
        .filter((name) => BACKUP_FILE_PATTERN.test(name))
        .map((name) => ({ name, full: path.join(dir, name), mtime: statSync(path.join(dir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1)),
    catch: (cause) => new Error(`Cannot list backups in ${dir}: ${String(cause)}`),
  })
  const deleted: Array<string> = []
  for (const entry of entries.slice(count)) {
    yield* Effect.try({
      try: () => rmSync(entry.full),
      catch: (cause) => new Error(`Cannot delete old backup ${entry.full}: ${String(cause)}`),
    })
    deleted.push(entry.full)
  }
  return { kept: entries.slice(0, count).map((entry) => entry.full), deleted } satisfies PruneResult
})

export interface BackupCycleOptions {
  /** Directory holding the timestamped backups. */
  readonly directory: string
  /** Live database file name, used for the timestamped backup name. */
  readonly database: string
  /** How many newest backups to keep; older ones are deleted. Defaults to 7. */
  readonly keep?: number
}

/** One scheduled backup: snapshot the live database, then rotate old backups. */
export const runBackupCycle = Effect.fn("DatabaseBackup.runCycle")(function* (db: Handle, options: BackupCycleOptions) {
  const backup = yield* backupDatabase(db, timestampedBackupPath(options.directory, options.database))
  const pruned = yield* pruneBackups(options.directory, options.keep ?? 7)
  return { backup, pruned }
})

/**
 * G2-8 (№44): replace the database at `database` with the backup at `backup`,
 * atomically — the live database is never deleted first.
 *
 * 1. The backup is verified (magic header + `PRAGMA quick_check`) before the
 *    live file is touched: a corrupt backup fails here and the live database
 *    is untouched.
 * 2. The live file and its `-wal`/`-shm` sidecars are moved aside to
 *    `<database>.pre-restore-<timestamp>[suffix]`, never deleted.
 * 3. The backup is copied into place and verified again; only then is the
 *    set-aside copy deleted.
 * 4. If the copy or the post-copy verification fails, the set-aside live
 *    database is moved back, so a failed restore leaves the old database
 *    exactly where it was.
 *
 * Call only with the server stopped (no open connection may hold the live
 * file): the open connection would keep writing to the replaced inode. A
 * corrupt live file is fine — its WAL checkpoint is best-effort and a failed
 * one never blocks the restore.
 */
export const restoreDatabase = Effect.fn("DatabaseBackup.restore")(function* (database: string, backup: string) {
  const file = path.resolve(database)
  const source = path.resolve(backup)
  if (!existsSync(source)) return yield* Effect.fail(new Error(`No backup file at ${source}`))
  const backupValid = yield* Effect.try({
    try: () => verifyDatabaseFile(source),
    catch: (cause) => new Error(`Cannot verify backup ${source}: ${String(cause)}`),
  })
  if (!backupValid)
    return yield* Effect.fail(
      new Error(`Backup at ${source} is not a valid SQLite database; live database untouched`),
    )
  yield* Effect.sync(() => {
    // A corrupt live file cannot checkpoint: the restore proceeds anyway.
    try {
      checkpointWal(file)
    } catch {
      // ignore
    }
  })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const aside = (suffix: string) => `${file}.pre-restore-${stamp}${suffix}`
  yield* Effect.try({
    try: () => {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) renameSync(file + suffix, aside(suffix))
    },
    catch: (cause) => new Error(`Cannot set aside live database ${file}: ${String(cause)}`),
  })
  const rollback = Effect.sync(() => {
    // Best-effort: remove a half-written replacement, then move the set-aside
    // live database back. Failures here are swallowed — the caller already
    // has the original error, and a second one would only hide it.
    try {
      if (existsSync(file)) rmSync(file)
    } catch {
      // ignore
    }
    for (const suffix of ["-shm", "-wal", ""]) {
      try {
        if (existsSync(aside(suffix))) renameSync(aside(suffix), file + suffix)
      } catch {
        // ignore
      }
    }
  })
  yield* Effect.try({
    try: () => copyFileSync(source, file),
    catch: (cause) => new Error(`Cannot restore ${file} from ${source}: ${String(cause)}`),
  }).pipe(Effect.tapError(() => rollback))
  yield* Effect.try({
    try: () => {
      if (!verifyDatabaseFile(file)) throw new Error(`Restored file ${file} failed verification`)
    },
    catch: (cause) => new Error(`Restored database ${file} failed verification: ${String(cause)}`),
  }).pipe(Effect.tapError(() => rollback))
  if (process.platform !== "win32") {
    yield* Effect.promise(() => chmod(file, 0o600))
  }
  yield* Effect.sync(() => {
    // The restore verified: the set-aside copy is no longer needed. The
    // backup file itself stays as the safety net.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (existsSync(aside(suffix))) rmSync(aside(suffix))
      } catch {
        // ignore
      }
    }
  })
  return file
})
