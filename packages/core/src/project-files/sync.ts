export * as ProjectFilesSync from "./sync.js"

import { Effect } from "effect"
import type { KV } from "../kv.js"
import type { Database } from "../database/database.js"
import { ProjectFilesErrors } from "./errors.js"
import { ProjectFilesHealth } from "./health.js"
import { ProjectFilesIndex } from "./index-file.js"
import { ProjectFilesSyncersState } from "./syncers-state.js"
import { ProjectFilesSyncersData } from "./syncers-data.js"
import { ProjectFilesSyncersIntegrations } from "./syncers-integrations.js"

/**
 * Sync is the mirror writer: it pulls the current state from the subsystem
 * that owns it (KV, the autoloop journal, the skill registry, ...) and
 * writes the `.orchestra` file. Files are mirrors, not a second source of
 * truth — sync overwrites them from the database, never the other way
 * around (that direction is `restoreFromFiles`).
 *
 * Every syncer runs best-effort: one file failing never blocks the
 * others, and the report names every file that failed instead of
 * failing the whole sync. After the syncers run, the index is refreshed
 * and health is recomputed, so a stale mirror shows up in `health.json`
 * instead of silently aging.
 */

export interface SyncDeps {
  readonly kv: KV.Interface
}

export type SyncEnv = Database.Service

export interface Syncer {
  /** The `.orchestra` relative path this syncer writes. */
  readonly file: string
  readonly sync: (
    directory: string,
    deps: SyncDeps,
  ) => Effect.Effect<void, ProjectFilesErrors.ProjectFileError, SyncEnv>
}

export const allSyncers = (): ReadonlyArray<Syncer> => [
  ...ProjectFilesSyncersState.SYNCERS,
  ...ProjectFilesSyncersData.SYNCERS,
  ...ProjectFilesSyncersIntegrations.SYNCERS,
]

export interface SyncFileResult {
  readonly file: string
  readonly status: "ok" | "failed"
  readonly error?: string
}

export interface SyncReport {
  readonly syncedAt: string
  readonly files: ReadonlyArray<SyncFileResult>
}

export const syncFile = (
  directory: string,
  file: string,
  deps: SyncDeps,
): Effect.Effect<SyncFileResult, never, SyncEnv> =>
  Effect.gen(function* () {
    const syncer = allSyncers().find((entry) => entry.file === file)
    if (syncer === undefined) return { file, status: "failed", error: `no syncer registered for ${file}` }
    const result = yield* syncer.sync(directory, deps).pipe(
      Effect.map(() => ({ file, status: "ok" as const })),
      Effect.catchTag("ProjectFiles.Error", (error) => Effect.succeed({ file, status: "failed" as const, error: error.message })),
    )
    return result
  })

export const syncAll = (
  directory: string,
  deps: SyncDeps,
): Effect.Effect<SyncReport, never, SyncEnv> =>
  Effect.gen(function* () {
    const files: Array<SyncFileResult> = []
    for (const syncer of allSyncers()) {
      files.push(yield* syncFile(directory, syncer.file, deps))
    }
    yield* ProjectFilesIndex.refreshIndex(directory).pipe(Effect.ignore)
    yield* ProjectFilesHealth.checkHealth(directory).pipe(Effect.ignore)
    return { syncedAt: new Date().toISOString(), files }
  })
