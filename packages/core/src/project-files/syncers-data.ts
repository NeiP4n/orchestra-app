export * as ProjectFilesSyncersData from "./syncers-data.js"

import { Effect } from "effect"
import { ProjectFilesData } from "./files-data.js"
import type { Syncer } from "./sync.js"

/**
 * Data-file syncers (slice S2). Each entry pulls the current state from
 * its subsystem and writes the mirror file: kanban from the DoD board,
 * errors/events/usage from the autoloop journal, quarantine from the
 * autoloop quarantine table, dod-history from the DoD when it changed.
 * DoD and zones need no syncer — their files already ARE their stores.
 */
export const SYNCERS: ReadonlyArray<Syncer> = [
  { file: ProjectFilesData.KANBAN_FILE, sync: ProjectFilesData.syncKanban },
  {
    // The directory descriptor carries the trailing slash; the syncer
    // reports under the same name.
    file: `${ProjectFilesData.DOD_HISTORY_DIR}/`,
    sync: (directory) => ProjectFilesData.snapshotDodIfChanged(directory).pipe(Effect.asVoid),
  },
  { file: ProjectFilesData.ERRORS_FILE, sync: ProjectFilesData.syncErrors },
  { file: ProjectFilesData.EVENTS_FILE, sync: ProjectFilesData.syncEvents },
  { file: ProjectFilesData.USAGE_FILE, sync: ProjectFilesData.syncUsage },
  { file: ProjectFilesData.QUARANTINE_FILE, sync: ProjectFilesData.syncQuarantine },
]
