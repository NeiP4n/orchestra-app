export * as ProjectFilesSyncersIntegrations from "./syncers-integrations.js"

import type { Syncer } from "./sync.js"

/**
 * Integration and skill syncers (slice S3). Each entry pulls the current
 * state from its subsystem and writes the mirror file: MCP servers from
 * the MCP config, the skill registry from the levels store. Filled in by
 * the slice together with `files-integrations.ts`.
 */
export const SYNCERS: ReadonlyArray<Syncer> = []
