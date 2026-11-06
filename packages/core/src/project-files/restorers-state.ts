export * as ProjectFilesRestorersState from "./restorers-state.js"

import type { Restorer } from "./restore.js"

/**
 * State-file restorers (slice S1). Each entry reads its mirror file and
 * writes the state back into the subsystem: rules into KV, society and
 * budget into the federation store. Filled in by the slice together with
 * `files-state.ts`.
 */
export const RESTORERS: ReadonlyArray<Restorer> = []
