export * as ProjectFilesRestore from "./restore.js"

import { Effect } from "effect"
import { ProjectFilesErrors } from "./errors.js"
import { ProjectFilesHealth } from "./health.js"
import { ProjectFilesIndex } from "./index-file.js"
import { ProjectFilesRestorersState } from "./restorers-state.js"
import { ProjectFilesRestorersData } from "./restorers-data.js"
import { ProjectFilesRestorersIntegrations } from "./restorers-integrations.js"
import type { SyncDeps, SyncEnv } from "./sync.js"

/**
 * Restore is the opposite direction of sync: it rebuilds the database
 * state from the `.orchestra` files after the database is gone. The
 * files are the recovery source — a project whose database was deleted
 * comes back from its files, and a project that moved is the same
 * project after its folder is copied.
 *
 * Every restorer runs best-effort and reports what it did: restored
 * (how many records it wrote back), skipped (the file was absent or
 * already matches), or failed (the file is corrupt or the write
 * failed). A failed restorer never blocks the others, and a corrupt
 * file fails the restore for its subsystem loudly instead of writing
 * back half a state. File-owned state (DoD, zones, ADR, briefing)
 * needs no restore — the file IS the store, so it is already there.
 */

export interface Restorer {
  /** The `.orchestra` relative path this restorer reads. */
  readonly file: string
  readonly restore: (
    directory: string,
    deps: SyncDeps,
  ) => Effect.Effect<RestoreEntry, ProjectFilesErrors.ProjectFileError, SyncEnv>
}

export interface RestoreEntry {
  readonly file: string
  readonly status: "restored" | "skipped" | "failed"
  readonly count?: number
  readonly error?: string
}

export interface RestoreReport {
  readonly restoredAt: string
  readonly entries: ReadonlyArray<RestoreEntry>
}

export const allRestorers = (): ReadonlyArray<Restorer> => [
  ...ProjectFilesRestorersState.RESTORERS,
  ...ProjectFilesRestorersData.RESTORERS,
  ...ProjectFilesRestorersIntegrations.RESTORERS,
]

export const restoreFromFiles = (
  directory: string,
  deps: SyncDeps,
): Effect.Effect<RestoreReport, never, SyncEnv> =>
  Effect.gen(function* () {
    const entries: Array<RestoreEntry> = []
    for (const restorer of allRestorers()) {
      const entry = yield* restorer.restore(directory, deps).pipe(
        Effect.catchTag("ProjectFiles.Error", (error) =>
          Effect.succeed({ file: restorer.file, status: "failed" as const, error: error.message })
        ),
      )
      entries.push(entry)
    }
    yield* ProjectFilesIndex.refreshIndex(directory).pipe(Effect.ignore)
    yield* ProjectFilesHealth.checkHealth(directory).pipe(Effect.ignore)
    return { restoredAt: new Date().toISOString(), entries }
  })
