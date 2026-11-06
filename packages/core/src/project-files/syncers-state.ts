export * as ProjectFilesSyncersState from "./syncers-state.js"

import type { Syncer } from "./sync.js"

/**
 * State-file syncers (slice S1). Each entry pulls the current state from
 * its subsystem and writes the mirror file: rules from KV, society and
 * budget from the federation store, tasks and decisions from DoD/ADR,
 * lifecycle from the federation stage. Filled in by the slice together
 * with `files-state.ts`.
 */
export const SYNCERS: ReadonlyArray<Syncer> = []
