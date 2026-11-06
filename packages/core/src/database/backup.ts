export * as DatabaseBackup from "./backup.js"

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, readFileSync, rmSync, statSync } from "node:fs"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { checkpointWal, readCredentialValues, verifyDatabaseFile } from "#sqlite"
import { CredentialEncryption } from "../credential/encryption.js"
import { Database } from "./database.js"

type Handle = Database.Interface["db"]

export interface BackupResult {
  readonly path: string
  readonly sizeBytes: number
  /** The key backup next to the database backup, when one was written. */
  readonly keyPath?: string
  /** Whether a credential-key backup was written next to the database backup. */
  readonly keyBackedUp: boolean
}

export interface BackupOptions {
  /**
   * The credential key file (`credential.key`) to copy next to the backup.
   * A backup is a pair — database + key — because the database holds
   * sealed credentials the key alone opens (A3-01): when the database holds
   * sealed rows and this is missing (or the file is missing), the backup
   * refuses to write rather than produce a backup that can never restore.
   */
  readonly keyFile?: string
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

/** The key backup for a database backup: the same path with `.key` appended. */
export const keyBackupPath = (backup: string): string => `${backup}.key`

/** File path of the database behind a live handle, or `undefined` for an in-memory database. */
export const databaseFile = Effect.fn("DatabaseBackup.databaseFile")(function* (db: Handle) {
  const rows = yield* db
    .all<{ seq: number; name: string; file: string }>("PRAGMA database_list")
    .pipe(Effect.orDie)
  const file = rows.find((row) => row.name === "main")?.file
  return file === undefined || file === "" ? undefined : file
})

const parseEnvelope = (value: unknown): CredentialEncryption.Envelope | undefined => {
  const parsed = typeof value === "string" ? safeJson(value) : value
  return parsed !== undefined && CredentialEncryption.isEnvelope(parsed) ? parsed : undefined
}

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** The sealed credential envelopes in a list of stored values. */
const sealedEnvelopes = (values: ReadonlyArray<unknown>): Array<CredentialEncryption.Envelope> =>
  values.flatMap((value) => {
    const envelope = parseEnvelope(value)
    return envelope === undefined ? [] : [envelope]
  })

/** The sealed credential envelopes in the live database, if it has a credential table at all. */
const liveSealedEnvelopes = (db: Handle) =>
  db
    .all<{ value: unknown }>("SELECT value FROM credential")
    .pipe(
      Effect.map((rows) => sealedEnvelopes(rows.map((row) => row.value))),
      Effect.catch(() => Effect.succeed([] as Array<CredentialEncryption.Envelope>)),
    )

/** Whether `key` opens at least one of the envelopes (trial decryption, no plaintext anywhere). */
const opensAny = (key: Buffer, envelopes: ReadonlyArray<CredentialEncryption.Envelope>): boolean =>
  envelopes.some((envelope) => {
    try {
      CredentialEncryption.decrypt(key, envelope)
      return true
    } catch {
      return false
    }
  })

const readKeyFile = (file: string): Buffer => {
  const key = readFileSync(file)
  if (key.length !== CredentialEncryption.KEY_BYTES)
    throw new Error(
      `credential key file ${file} must hold ${CredentialEncryption.KEY_BYTES} bytes, found ${key.length}`,
    )
  return key
}

/**
 * Copy the live database to `destination` as one consistent snapshot
 * (`VACUUM INTO` reads the database including its WAL, so the backup never
 * catches the file mid-write). Overwrites an existing file at the destination.
 * Call this before any destructive work and before the first live Society run:
 * without a backup, one power failure is the loss of every project, session
 * and journal fact.
 *
 * A3-02: the written backup is verified (magic header + `PRAGMA quick_check`)
 * before this returns — a truncated or corrupt backup is deleted on the spot
 * instead of ageing into the rotation and being found on the day of the crash.
 *
 * A3-01: the backup is a pair. When `options.keyFile` is given, the key file
 * is copied next to the database backup (`<backup>.key`, 0600). When the
 * database holds sealed credentials and no usable key file is available, the
 * backup fails instead of writing a database that can never be restored.
 */
export const backupDatabase = Effect.fn("DatabaseBackup.backup")(function* (
  db: Handle,
  destination: string,
  options?: BackupOptions,
) {
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
  if (!verifyDatabaseFile(file)) {
    yield* Effect.sync(() => {
      try {
        rmSync(file)
      } catch {
        // ignore: the failure below already says the backup is unusable
      }
    })
    return yield* Effect.fail(
      new Error(`Backup at ${file} failed verification after writing and was deleted; live database untouched`),
    )
  }
  const keyFile = options?.keyFile === undefined ? undefined : path.resolve(options.keyFile)
  const sealed = yield* liveSealedEnvelopes(db)
  let keyPath: string | undefined
  if (keyFile !== undefined && existsSync(keyFile)) {
    keyPath = keyBackupPath(file)
    yield* Effect.try({
      try: () => copyFileSync(keyFile, keyPath),
      catch: (cause) => new Error(`Cannot back up credential key ${keyFile} to ${keyPath}: ${String(cause)}`),
    })
    if (process.platform !== "win32") {
      yield* Effect.promise(() => chmod(keyPath as string, 0o600))
    }
  } else if (sealed.length > 0) {
    yield* Effect.sync(() => {
      try {
        rmSync(file)
      } catch {
        // ignore: the failure below already says the backup is unusable
      }
    })
    return yield* Effect.fail(
      new Error(
        `Refusing to back up a database holding ${sealed.length} encrypted credential(s): ` +
          `the credential key file ${keyFile ?? "(no key file configured)"} is missing, ` +
          `so the backup could never restore them. Restore the key file, then back up again.`,
      ),
    )
  } else if (keyFile !== undefined) {
    yield* Effect.logWarning("database backup has no credential key to copy", {
      keyFile,
      reason: "key file missing but the database holds no encrypted credentials yet",
    })
  }
  return { path: file, sizeBytes, ...(keyPath ? { keyPath } : {}), keyBackedUp: keyPath !== undefined } satisfies BackupResult
})

export interface PruneResult {
  readonly kept: ReadonlyArray<string>
  readonly deleted: ReadonlyArray<string>
}

/**
 * G2-8 (№43): keep the `keep` newest timestamped backups in `directory` and
 * delete the older ones. Only files matching the timestamped backup name are
 * touched; a missing directory prunes nothing. Newest-first by modification
 * time, ties broken by name so the result is deterministic. A pruned backup's
 * key sibling (`<backup>.key`, A3-01) is deleted with it, so a rotated-out
 * database never leaves an orphaned key behind.
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
      try: () => {
        rmSync(entry.full)
        const sibling = keyBackupPath(entry.full)
        if (existsSync(sibling)) rmSync(sibling)
      },
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
  /** Credential key file to copy next to each backup (A3-01). */
  readonly keyFile?: string
}

/**
 * One scheduled backup: snapshot the live database, then rotate old backups.
 * Rotation only runs after a verified backup (A3-02): a failed cycle never
 * deletes the previous good backup.
 */
export const runBackupCycle = Effect.fn("DatabaseBackup.runCycle")(function* (db: Handle, options: BackupCycleOptions) {
  const backup = yield* backupDatabase(db, timestampedBackupPath(options.directory, options.database), {
    keyFile: options.keyFile,
  })
  const pruned = yield* pruneBackups(options.directory, options.keep ?? 7)
  return { backup, pruned }
})

export interface RestoreResult {
  /** The restored database file. */
  readonly database: string
  /** What happened to the credential key: restored from the backup's pair, kept from the live install, or not needed. */
  readonly key: "restored" | "kept-live" | "none"
}

/**
 * G2-8 (№44) + A3-01: replace the database at `database` with the backup at
 * `backup`, atomically — the live database is never deleted first. The backup
 * is a pair (database + `credential.key`): both files are restored together
 * or neither is.
 *
 * 1. The backup is verified (magic header + `PRAGMA quick_check`) before the
 *    live file is touched: a corrupt backup fails here and the live database
 *    is untouched.
 * 2. The key is settled before anything moves: when the backup holds sealed
 *    credentials, the key that opens them must be proven — from the backup's
 *    `<backup>.key` sibling, or from the live key file when it opens at
 *    least one sealed row. A backup whose sealed rows no available key opens
 *    fails here: restoring it would leave undecryptable credentials.
 * 3. The live file and its `-wal`/`-shm` sidecars are moved aside to
 *    `<database>.pre-restore-<timestamp>[suffix]`, never deleted; the live
 *    key file, when it is being replaced, is moved aside the same way.
 * 4. The backup is copied into place and verified again, and the restored
 *    key is proven against the restored database's sealed rows; only then
 *    are the set-aside copies deleted.
 * 5. If the copy or either verification fails, the set-aside live database
 *    and key are moved back, so a failed restore leaves the old database
 *    and the old key exactly where they were.
 *
 * Call only with the server stopped (no open connection may hold the live
 * file): the open connection would keep writing to the replaced inode. A
 * corrupt live file is fine — its WAL checkpoint is best-effort and a failed
 * one never blocks the restore. `options.keyFile` is the live key file; it
 * defaults to `credential.key` next to the database.
 */
export const restoreDatabase = Effect.fn("DatabaseBackup.restore")(function* (
  database: string,
  backup: string,
  options?: BackupOptions,
) {
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
  const backupEnvelopes = yield* Effect.try({
    try: () => sealedEnvelopes(readCredentialValues(source)),
    catch: (cause) => new Error(`Cannot read credentials from backup ${source}: ${String(cause)}`),
  })
  const keyTarget = options?.keyFile === undefined ? path.join(path.dirname(file), "credential.key") : path.resolve(options.keyFile)
  const keySource = keyBackupPath(source)
  // Settle the key before the live files are touched: which key opens the
  // backup's sealed rows, and where does it come from?
  let keyAction: RestoreResult["key"]
  let keyBytes: Buffer | undefined
  if (existsSync(keySource)) {
    keyBytes = yield* Effect.try({
      try: () => readKeyFile(keySource),
      catch: (cause) => new Error(`Cannot read backup key ${keySource}: ${String(cause)}`),
    })
    if (backupEnvelopes.length > 0 && !opensAny(keyBytes, backupEnvelopes))
      return yield* Effect.fail(
        new Error(
          `Backup key ${keySource} does not open the backup's ${backupEnvelopes.length} encrypted credential(s); ` +
            `live database and key untouched`,
        ),
      )
    keyAction = "restored"
  } else if (backupEnvelopes.length > 0) {
    if (!existsSync(keyTarget))
      return yield* Effect.fail(
        new Error(
          `Backup at ${source} holds ${backupEnvelopes.length} encrypted credential(s) but no key backup ` +
            `(${keySource}) and no live key file (${keyTarget}); live database untouched. ` +
            `Restore the matching credential.key next to the backup, then restore again.`,
        ),
      )
    keyBytes = yield* Effect.try({
      try: () => readKeyFile(keyTarget),
      catch: (cause) => new Error(`Cannot read live credential key ${keyTarget}: ${String(cause)}`),
    })
    if (!opensAny(keyBytes, backupEnvelopes))
      return yield* Effect.fail(
        new Error(
          `The live credential key ${keyTarget} does not open the backup's ${backupEnvelopes.length} encrypted credential(s) ` +
            `(the backup came from another install); live database untouched. ` +
            `Restore the matching credential.key next to the backup, then restore again.`,
        ),
      )
    keyAction = "kept-live"
  } else {
    keyAction = "none"
  }
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
  const asideKey = `${keyTarget}.pre-restore-${stamp}`
  yield* Effect.try({
    try: () => {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) renameSync(file + suffix, aside(suffix))
      if (keyAction === "restored" && existsSync(keyTarget)) renameSync(keyTarget, asideKey)
    },
    catch: (cause) => new Error(`Cannot set aside live database ${file}: ${String(cause)}`),
  })
  const rollback = Effect.sync(() => {
    // Best-effort: remove half-written replacements, then move the set-aside
    // live database and key back. Failures here are swallowed — the caller already
    // has the original error, and a second one would only hide it.
    try {
      if (existsSync(file)) rmSync(file)
    } catch {
      // ignore
    }
    try {
      if (existsSync(keyTarget) && keyAction === "restored") rmSync(keyTarget)
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
    try {
      if (existsSync(asideKey)) renameSync(asideKey, keyTarget)
    } catch {
      // ignore
    }
  })
  yield* Effect.try({
    try: () => {
      if (keyAction === "restored" && keyBytes !== undefined) {
        copyFileSync(keySource, keyTarget)
        // Synchronous chmod keeps the key 0600 from the first byte the next
        // reader can see; the async chmod below is for the database only.
        if (process.platform !== "win32") chmodSync(keyTarget, 0o600)
      }
      copyFileSync(source, file)
    },
    catch: (cause) => new Error(`Cannot restore ${file} from ${source}: ${String(cause)}`),
  }).pipe(Effect.tapError(() => rollback))
  yield* Effect.try({
    try: () => {
      if (!verifyDatabaseFile(file)) throw new Error(`Restored file ${file} failed verification`)
      if (backupEnvelopes.length > 0) {
        const restoredEnvelopes = sealedEnvelopes(readCredentialValues(file))
        const finalKey = keyBytes ?? readKeyFile(keyTarget)
        if (!opensAny(finalKey, restoredEnvelopes))
          throw new Error(`Restored key does not open the restored database's encrypted credentials`)
      }
    },
    catch: (cause) => new Error(`Restored database ${file} failed verification: ${String(cause)}`),
  }).pipe(Effect.tapError(() => rollback))
  if (process.platform !== "win32") {
    yield* Effect.promise(() => chmod(file, 0o600))
  }
  yield* Effect.sync(() => {
    // The restore verified: the set-aside copies are no longer needed. The
    // backup file itself stays as the safety net.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (existsSync(aside(suffix))) rmSync(aside(suffix))
      } catch {
        // ignore
      }
    }
    try {
      if (existsSync(asideKey)) rmSync(asideKey)
    } catch {
      // ignore
    }
  })
  return { database: file, key: keyAction } satisfies RestoreResult
})
