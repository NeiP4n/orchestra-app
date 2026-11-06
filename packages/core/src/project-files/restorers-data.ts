export * as ProjectFilesRestorersData from "./restorers-data.js"

import type { Restorer } from "./restore.js"

/**
 * Data-file restorers (slice S2). Each entry reads its mirror file and
 * writes the state back into the subsystem: quarantine back into the
 * autoloop quarantine table (a poisoned fact must stay quarantined
 * after a file-only restore), usage/errors/events back into the journal.
 * Filled in by the slice together with `files-data.ts`.
 */
export const RESTORERS: ReadonlyArray<Restorer> = []
