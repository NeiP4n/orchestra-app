export * as ServerDatabaseBackup from "./database-backup"

import { Database } from "@orchestra/core/database/database"
import { DatabaseBackup } from "@orchestra/core/database/backup"
import { Global } from "@orchestra/util/global"
import { Cause, Duration, Effect } from "effect"
import path from "node:path"

/**
 * G2-8 (№42): the live database backs itself up on a schedule. Wired into
 * `ServerProcess.start`, not `ServerFetch.make`: workerd has no filesystem
 * database to snapshot, and an embedder owns its own storage lifecycle.
 */
export interface DatabaseBackupOptions {
  /** Set false to disable automatic backups. Defaults to true. */
  readonly enabled?: boolean
  /** Hours between backups. Defaults to 6. */
  readonly intervalHours?: number
  /** How many newest backups to keep; older ones are deleted. Defaults to 7. */
  readonly keep?: number
  /** Backup directory. Defaults to `<data>/backups`. */
  readonly directory?: string
}

export const DEFAULT_INTERVAL_HOURS = 6
export const DEFAULT_KEEP = 7

/**
 * One backup cycle against the live database. Returns the backup path, or
 * `undefined` for an in-memory database (nothing durable to snapshot).
 * Failures propagate — the caller logs them; the schedule never fails a boot.
 */
export const runCycle = Effect.fn("ServerDatabaseBackup.runCycle")(function* (
  db: Database.Interface["db"],
  global: Global.Interface,
  options?: DatabaseBackupOptions,
) {
  const file = yield* DatabaseBackup.databaseFile(db)
  if (file === undefined) {
    yield* Effect.logInfo("database backup skipped: in-memory database")
    return undefined
  }
  const directory = options?.directory ?? path.join(global.data, "backups")
  const result = yield* DatabaseBackup.runBackupCycle(db, {
    directory,
    database: path.basename(file),
    keep: options?.keep ?? DEFAULT_KEEP,
  })
  yield* Effect.logInfo("database backup completed", {
    backup: result.backup.path,
    sizeBytes: result.backup.sizeBytes,
    pruned: result.pruned.deleted.length,
  })
  return result.backup.path
})

/**
 * Fork a scoped fiber into the server's lifetime: one backup immediately —
 * before the first live Society run resumes at boot — then one every
 * `intervalHours`. A failed cycle is one loud warning; the next cycle still
 * runs, and the server never fails to boot over a backup.
 */
export const start = Effect.fn("ServerDatabaseBackup.start")(function* (
  db: Database.Interface["db"],
  global: Global.Interface,
  options?: DatabaseBackupOptions,
) {
  if (options?.enabled === false) return
  const interval = Duration.hours(options?.intervalHours ?? DEFAULT_INTERVAL_HOURS)
  const cycle = runCycle(db, global, options).pipe(
    Effect.catchCause((cause) =>
      // An interrupted backup is the server shutting down, not a failed
      // backup: let the interruption end the fiber instead of logging it
      // as a warning and scheduling another cycle.
      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.logWarning("database backup failed", { cause }),
    ),
  )
  yield* Effect.forkScoped(Effect.forever(cycle.pipe(Effect.andThen(Effect.sleep(interval)))))
})
