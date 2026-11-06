export * as ProjectFilesRestorersIntegrations from "./restorers-integrations.js"

import type { Restorer } from "./restore.js"

/**
 * Integration and skill restorers (slice S3). Each entry reads its
 * mirror file and writes the state back into the subsystem: MCP servers
 * into the MCP config, the skill registry into the levels store. Filled
 * in by the slice together with `files-integrations.ts`.
 */
export const RESTORERS: ReadonlyArray<Restorer> = []
