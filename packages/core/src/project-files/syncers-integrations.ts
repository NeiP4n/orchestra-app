export * as ProjectFilesSyncersIntegrations from "./syncers-integrations.js"

import { Effect } from "effect"
import { ProjectFilesErrors } from "./errors.js"
import { ProjectFilesIntegrations } from "./files-integrations.js"
import type { Syncer } from "./sync.js"

/**
 * Integration and skill syncers (slice S3).
 *
 * `mcp.yaml` and `skills.json` are file-owned (source `file`): the file
 * IS the store, there is no database to pull from, so sync validates
 * them instead of rewriting them — a corrupt file or a secret value
 * fails the sync loudly instead of aging silently, and a missing file
 * is fine (a fresh project has no per-project servers and an empty
 * skill level). `INTEGRATE.md` is derived: sync regenerates it from
 * the installed manifests.
 */
export const SYNCERS: ReadonlyArray<Syncer> = [
  {
    file: ProjectFilesIntegrations.MCP_FILE,
    sync: (directory) =>
      ProjectFilesIntegrations.readMcp(directory).pipe(
        Effect.asVoid,
        Effect.catchTag("ProjectFiles.Error", (error) =>
          error.kind === "missing" ? Effect.void : Effect.fail(error)
        ),
      ),
  },
  {
    file: ProjectFilesIntegrations.INTEGRATE_DOC,
    sync: (directory) => ProjectFilesIntegrations.updateIntegrateDoc(directory),
  },
  {
    file: ProjectFilesIntegrations.SKILLS_REGISTRY_REL,
    sync: (directory) =>
      ProjectFilesIntegrations.readSkillRegistry(directory).pipe(
        Effect.flatMap((loaded) =>
          loaded.degraded
            ? Effect.fail(
                ProjectFilesErrors.corrupt(
                  ProjectFilesIntegrations.skillRegistryPath(directory),
                  `project skill registry is damaged: ${loaded.damage ?? "unknown damage"}`,
                ),
              )
            : Effect.void,
        ),
      ),
  },
]
