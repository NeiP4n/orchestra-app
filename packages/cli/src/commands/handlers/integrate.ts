import { EOL } from "node:os"
import { readFile } from "node:fs/promises"
import { Effect } from "effect"
import { ProjectFilesErrors } from "@orchestra/core/project-files/errors"
import { ProjectFilesIntegrations } from "@orchestra/core/project-files/files-integrations"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"

/**
 * `orchestra integrate` — the CLI front for
 * `ProjectFilesIntegrations.integrate`: read a manifest file (YAML or
 * JSON), validate it, and install it into this project
 * (`.orchestra/integrations/<name>.yaml`, plus the `mcp.yaml` server
 * entry for MCP/catalog kinds). `--dry-run` validates only and writes
 * nothing; `--force` overwrites an already installed integration with
 * the same name. The project is the current directory, like `mcp add`.
 * No network is touched: verification here is the offline shape check
 * the core layer does; live probes belong to a later `check` step.
 */

export interface IntegrateOutcome {
  readonly name: string
  readonly type: ProjectFilesIntegrations.IntegrationKind
  readonly installed: boolean
  /** Manifest path relative to `.orchestra/` (the same form the core report uses). */
  readonly manifest: string
  readonly verified: boolean
  readonly durationMs: number
}

/** Reads a manifest file: JSON (`.json`) or YAML (anything else) by extension. */
export const loadManifestSpec = (
  file: string,
): Effect.Effect<unknown, ProjectFilesErrors.ProjectFileError> =>
  Effect.tryPromise({
    try: async () => {
      const text = await readFile(file, "utf8")
      return file.endsWith(".json") ? (JSON.parse(text) as unknown) : Bun.YAML.parse(text)
    },
    catch: (error) => ProjectFilesErrors.invalid(file, `cannot read manifest ${file}: ${String(error)}`),
  })

/** Validates (and, unless dry-run, installs) a manifest file into the project. No services needed. */
export const runIntegrate = (
  directory: string,
  manifestFile: string,
  options?: { dryRun?: boolean; force?: boolean },
): Effect.Effect<IntegrateOutcome, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    const spec = yield* loadManifestSpec(manifestFile)
    if (options?.dryRun === true) {
      const manifest = yield* ProjectFilesIntegrations.validateManifest(spec)
      return {
        name: manifest.name,
        type: manifest.kind,
        installed: false,
        manifest: `integrations/${manifest.name}.yaml`,
        verified: true,
        durationMs: Date.now() - startedAt,
      }
    }
    const report = yield* ProjectFilesIntegrations.integrate(directory, spec, { force: options?.force })
    return { ...report, installed: true }
  })

export const formatOutcome = (outcome: IntegrateOutcome): string =>
  outcome.installed
    ? `Installed "${outcome.name}" (${outcome.type}) → .orchestra/${outcome.manifest} (verified: ${outcome.verified ? "yes" : "no"}, ${outcome.durationMs}ms)`
    : `Manifest "${outcome.name}" (${outcome.type}) is valid — nothing installed (would write .orchestra/${outcome.manifest})`

export default Runtime.handler(
  Commands.commands.integrate,
  Effect.fn("cli.integrate")(function* (input) {
    const outcome = yield* runIntegrate(process.cwd(), input.manifest, {
      dryRun: input.dryRun,
      force: input.force,
    })
    process.stdout.write(`${formatOutcome(outcome)}${EOL}`)
  }),
)
