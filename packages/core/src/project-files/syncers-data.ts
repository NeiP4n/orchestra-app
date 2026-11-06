export * as ProjectFilesSyncersData from "./syncers-data.js"

import type { Syncer } from "./sync.js"

/**
 * Data-file syncers (slice S2). Each entry pulls the current state from
 * its subsystem and writes the mirror file: kanban from the DoD board,
 * errors/events/usage from the autoloop journal, quarantine from the
 * autoloop quarantine table. DoD and zones need no syncer — their files
 * already ARE their stores. Filled in by the slice together with
 * `files-data.ts`.
 */
export const SYNCERS: ReadonlyArray<Syncer> = []
