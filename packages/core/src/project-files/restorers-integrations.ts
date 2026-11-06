export * as ProjectFilesRestorersIntegrations from "./restorers-integrations.js"

import { Effect } from "effect"
import { ProjectFilesErrors } from "./errors.js"
import { ProjectFilesIntegrations } from "./files-integrations.js"
import type { Restorer, RestoreEntry } from "./restore.js"

/**
 * Integration and skill restorers (slice S3).
 *
 * File-owned state needs no restore — the file IS the store, so it is
 * already there: `mcp.yaml` and `skills.json` report `skipped` when
 * present and valid, and fail loudly (corrupt) when damaged instead of
 * writing back half a state. `INTEGRATE.md` is derived, so restore
 * regenerates it from the installed manifests.
 */
const skipped = (file: string): RestoreEntry => ({ file, status: "skipped" })

export const RESTORERS: ReadonlyArray<Restorer> = [
  {
    file: ProjectFilesIntegrations.MCP_FILE,
    restore: (directory) =>
      ProjectFilesIntegrations.readMcp(directory).pipe(
        Effect.map(() => skipped(ProjectFilesIntegrations.MCP_FILE)),
        Effect.catchTag("ProjectFiles.Error", (error) =>
          error.kind === "missing"
            ? Effect.succeed(skipped(ProjectFilesIntegrations.MCP_FILE))
            : Effect.fail(error)
        ),
      ),
  },
  {
    file: ProjectFilesIntegrations.SKILLS_REGISTRY_REL,
    restore: (directory) =>
      ProjectFilesIntegrations.readSkillRegistry(directory).pipe(
        Effect.flatMap((loaded) =>
          loaded.degraded
            ? Effect.fail(
                ProjectFilesErrors.corrupt(
                  ProjectFilesIntegrations.skillRegistryPath(directory),
                  `project skill registry is damaged: ${loaded.damage ?? "unknown damage"}`,
                ),
              )
            : Effect.succeed(skipped(ProjectFilesIntegrations.SKILLS_REGISTRY_REL)),
        ),
      ),
  },
  {
    file: ProjectFilesIntegrations.INTEGRATE_DOC,
    restore: (directory) =>
      ProjectFilesIntegrations.updateIntegrateDoc(directory).pipe(
        Effect.flatMap(() => ProjectFilesIntegrations.listIntegrations(directory)),
        Effect.map((installed) => ({
          file: ProjectFilesIntegrations.INTEGRATE_DOC,
          status: "restored" as const,
          count: installed.length,
        })),
      ),
  },
]
