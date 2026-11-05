export * as DatabaseBackup from "./backup.js"

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { checkpointWal } from "#sqlite"
import { Database } from "./database.js"

type Handle = Database.Interface["db"]

export interface BackupResult {
  readonly path: string
  readonly sizeBytes: number
}

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
  return { path: file, sizeBytes } satisfies BackupResult
})

/**
 * Replace the database at `database` with the backup at `backup`. Call only
 * with the server stopped (no open connection may hold the live file): the
 * open connection would keep writing to the replaced inode. A corrupt live
 * file is fine — its WAL checkpoint is best-effort and a failed one never
 * blocks the restore.
 */
export const restoreDatabase = Effect.fn("DatabaseBackup.restore")(function* (database: string, backup: string) {
  const file = path.resolve(database)
  const source = path.resolve(backup)
  if (!existsSync(source)) return yield* Effect.fail(new Error(`No backup file at ${source}`))
  yield* Effect.sync(() => {
    // A corrupt live file cannot checkpoint: the restore proceeds anyway.
    try {
      checkpointWal(file)
    } catch {
      // ignore
    }
  })
  yield* Effect.try({
    try: () => {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) rmSync(file + suffix)
      copyFileSync(source, file)
    },
    catch: (cause) => new Error(`Cannot restore ${file} from ${source}: ${String(cause)}`),
  })
  if (process.platform !== "win32") {
    yield* Effect.promise(() => chmod(file, 0o600))
  }
  return file
})
