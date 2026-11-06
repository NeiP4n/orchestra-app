export * as ProjectFilesRestorersData from "./restorers-data.js"

import { ProjectFilesData } from "./files-data.js"
import type { Restorer } from "./restore.js"

/**
 * Data-file restorers (slice S2). Only quarantine has one: it reads
 * `quarantine.jsonl` and re-quarantines every listed fact, so a poisoned
 * fact stays quarantined after a file-only restore instead of being
 * replayed by the next rebuild.
 *
 * Deliberately no restorers for the rest:
 * - errors/events/usage are append-only journal mirrors whose `seq` is
 *   assigned by the database — replaying their lines would mint new
 *   sequences and duplicate facts. The journal is the truth; the files
 *   are its shadow.
 * - kanban.yaml is derived from the DoD board; the board is the store.
 * - dod-history/ is history, not state: an old board is never written back.
 */
export const RESTORERS: ReadonlyArray<Restorer> = [
  { file: ProjectFilesData.QUARANTINE_FILE, restore: ProjectFilesData.restoreQuarantine },
]
