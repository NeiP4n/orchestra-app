export * as ProjectFilesRestorersState from "./restorers-state.js"

import { ProjectFilesState } from "./files-state.js"
import type { Restorer } from "./restore.js"

/**
 * State-file restorers (slice S1). Each entry reads its mirror file and
 * writes the state back into the subsystem: rules into KV, society and
 * budget into the federation store. Derived files (tasks, decisions)
 * have no restorer — their source is already a file, so sync regenerates
 * them. File-owned state (orchestra.json, briefing, handoffs,
 * lifecycle) needs no restore either: the file IS the store, so it is
 * already there.
 */
export const RESTORERS: ReadonlyArray<Restorer> = [
  { file: ProjectFilesState.RULES_FILE, restore: ProjectFilesState.restoreRules },
  { file: ProjectFilesState.SOCIETY_FILE, restore: ProjectFilesState.restoreSociety },
  { file: ProjectFilesState.BUDGET_FILE, restore: ProjectFilesState.restoreBudget },
]
