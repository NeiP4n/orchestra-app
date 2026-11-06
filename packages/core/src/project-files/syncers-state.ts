export * as ProjectFilesSyncersState from "./syncers-state.js"

import { ProjectFilesState } from "./files-state.js"
import type { Syncer } from "./sync.js"

/**
 * State-file syncers (slice S1). Each entry pulls the current state from
 * its subsystem and writes the mirror file: rules from KV, society and
 * budget from the federation store, tasks and decisions from DoD/ADR.
 * File-owned state (orchestra.json, briefing, handoffs, lifecycle) has
 * no syncer: the file IS the store, there is nothing to mirror from.
 */
export const SYNCERS: ReadonlyArray<Syncer> = [
  { file: ProjectFilesState.RULES_FILE, sync: ProjectFilesState.syncRules },
  { file: ProjectFilesState.TASKS_FILE, sync: ProjectFilesState.syncTasks },
  { file: ProjectFilesState.DECISIONS_FILE, sync: ProjectFilesState.syncDecisions },
  { file: ProjectFilesState.SOCIETY_FILE, sync: ProjectFilesState.syncSociety },
  { file: ProjectFilesState.BUDGET_FILE, sync: ProjectFilesState.syncBudget },
]
