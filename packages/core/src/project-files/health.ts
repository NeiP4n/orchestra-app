export * as ProjectFilesHealth from "./health.js"

import { Effect, Schema } from "effect"
import { ProjectFilesErrors } from "./errors.js"
import { ProjectFilesFormat } from "./format.js"
import { ProjectFilesIndex } from "./index-file.js"
import { ProjectFilesPaths } from "./paths.js"
import { ProjectFilesRegistry } from "./registry.js"

/**
 * Health (`health.json`) is the project's self-check: one line per file
 * in the registry — ok, missing, corrupt, divergent, or unchecked — and
 * one overall status. A divergence between a file and the database is
 * an error visible here, never a silent drift: the file says one thing,
 * the database says another, and `health.json` names the file.
 *
 * The core checks existence and parseability for every registered file
 * (a `.yaml` that does not parse is `corrupt`, a `.jsonl` with a bad line
 * is `corrupt`). Divergence comes from the slices: each slice compares
 * its mirrored files with the subsystem that owns them and passes the
 * divergent ones in. A file nobody compared is `unchecked`, not `ok`.
 */

export const FileHealthStatus = Schema.Literals(["ok", "missing", "corrupt", "divergent", "unchecked"])
export type FileHealthStatus = typeof FileHealthStatus.Type

export const FileHealth = Schema.Struct({
  path: Schema.String,
  status: FileHealthStatus,
  detail: Schema.optional(Schema.String),
})
export type FileHealth = typeof FileHealth.Type

export const HealthReport = Schema.Struct({
  version: Schema.Literal(1),
  checkedAt: Schema.String,
  status: Schema.Literals(["healthy", "degraded", "unhealthy", "unchecked"]),
  files: Schema.Array(FileHealth),
})
export type HealthReport = typeof HealthReport.Type

/** A divergence found by a slice: this file disagrees with its database source. */
export interface Divergence {
  readonly path: string
  readonly detail: string
}

const parseStatus = (rel: string, text: string): "ok" | "corrupt" => {
  try {
    if (rel.endsWith(".yaml") || rel.endsWith(".yml")) Bun.YAML.parse(text)
    else if (rel.endsWith(".json")) JSON.parse(text)
    else if (rel.endsWith(".jsonl")) {
      for (const line of text.split("\n").filter((entry) => entry.trim() !== "")) JSON.parse(line)
    }
    return "ok"
  } catch {
    return "corrupt"
  }
}

const checkOne = (
  directory: string,
  descriptor: { rel: string; dir: boolean },
  divergent: ReadonlyMap<string, string>,
): Effect.Effect<FileHealth, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    if (descriptor.dir) {
      const exists = yield* ProjectFilesFormat.exists(
        ProjectFilesPaths.writePath(directory, descriptor.rel, descriptor.base),
      )
      return { path: descriptor.rel, status: exists ? "ok" : "missing" }
    }
    const detail = divergent.get(descriptor.rel)
    if (detail !== undefined) return { path: descriptor.rel, status: "divergent", detail }
    const file = ProjectFilesPaths.readPath(directory, descriptor.rel, descriptor.base)
    const exists = yield* ProjectFilesFormat.exists(file)
    if (!exists) return { path: descriptor.rel, status: "missing" }
    const text = yield* ProjectFilesFormat.readText(file)
    const parsed = parseStatus(descriptor.rel, text)
    return parsed === "ok"
      ? { path: descriptor.rel, status: "ok" }
      : { path: descriptor.rel, status: "corrupt", detail: `${descriptor.rel} does not parse` }
  })

/**
 * Computes the health report and writes it to `health.json`. The report
 * itself is generated, never hand-edited: writing it by hand would hide
 * the next divergence instead of reporting it.
 */
export const checkHealth = (
  directory: string,
  divergences: ReadonlyArray<Divergence> = [],
): Effect.Effect<HealthReport, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const divergent = new Map(divergences.map((entry) => [entry.path, entry.detail]))
    const index = yield* ProjectFilesIndex.readIndex(directory).pipe(
      Effect.catchTag("ProjectFiles.Error", (error) =>
        error.kind === "corrupt"
          ? Effect.succeed({ version: 1 as const, generatedAt: "", entries: [] })
          : Effect.fail(error)
      ),
    )
    const files: Array<FileHealth> = []
    for (const descriptor of ProjectFilesRegistry.allDescriptors()) {
      // health.json is the report being written right now: it is ok by
      // construction, and checking it before the write would make every
      // first check degraded for a file that is about to exist.
      if (descriptor.rel === ProjectFilesPaths.HEALTH_FILE) continue
      files.push(yield* checkOne(directory, descriptor, divergent))
    }
    // A divergence names a real file even when its descriptor has not
    // landed yet (a slice registers its files with its own commit): the
    // file still shows up as divergent instead of being dropped silently.
    for (const entry of divergences) {
      if (!files.some((file) => file.path === entry.path)) {
        files.push({ path: entry.path, status: "divergent", detail: entry.detail })
      }
    }
    for (const entry of index.entries) {
      if (entry.kind === "unknown") {
        files.push({ path: entry.path, status: "unchecked", detail: "Unregistered file — add a descriptor or remove it" })
      }
    }
    const indexFile = ProjectFilesPaths.readPath(directory, ProjectFilesPaths.INDEX_FILE)
    const indexExists = yield* ProjectFilesFormat.exists(indexFile)
    const indexHealth: FileHealth = !indexExists
      ? { path: ProjectFilesPaths.INDEX_FILE, status: "missing" }
      : yield* ProjectFilesIndex.readIndex(directory).pipe(
          Effect.map(() => ({ path: ProjectFilesPaths.INDEX_FILE, status: "ok" as const })),
          Effect.catchTag("ProjectFiles.Error", (error) =>
            Effect.succeed({ path: ProjectFilesPaths.INDEX_FILE, status: "corrupt" as const, detail: error.message })
          ),
        )
    files.push(indexHealth)
    files.push({ path: ProjectFilesPaths.HEALTH_FILE, status: "ok" })
    files.sort((a, b) => (a.path < b.path ? -1 : 1))
    const status = files.some((file) => file.status === "corrupt")
      ? "unhealthy"
      : files.some((file) => file.status === "divergent" || file.status === "missing" || file.status === "unchecked")
        ? "degraded"
        : "healthy"
    const report: HealthReport = { version: 1, checkedAt: new Date().toISOString(), status, files }
    yield* ProjectFilesFormat.writeJson(ProjectFilesPaths.writePath(directory, ProjectFilesPaths.HEALTH_FILE), report)
    return report
  })

/** Reads the last health report. A missing report is `unchecked` overall, never an error. */
export const readHealth = (directory: string): Effect.Effect<HealthReport, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const file = ProjectFilesPaths.readPath(directory, ProjectFilesPaths.HEALTH_FILE)
    const exists = yield* ProjectFilesFormat.exists(file)
    if (!exists) {
      return { version: 1 as const, checkedAt: new Date(0).toISOString(), status: "unchecked" as const, files: [] }
    }
    return yield* ProjectFilesFormat.readJson(file, HealthReport)
  })
