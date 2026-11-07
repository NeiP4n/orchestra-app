export * as ProjectFilesSnapshot from "./snapshot.js"

import { readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { ProjectFilesErrors } from "./errors.js"
import { ProjectFilesFormat } from "./format.js"
import { ProjectFilesIndex } from "./index-file.js"
import { ProjectFilesPaths } from "./paths.js"
import { ProjectFilesRegistry } from "./registry.js"

/**
 * Snapshots are the rollback point: a full copy of `.orchestra`
 * (minus the snapshots themselves) with a manifest that lists every
 * file it holds — plus the project's state files that live OUTSIDE
 * `.orchestra` but are registered in the registry with base `project`
 * (today only `native-skills/skills.json`). Those ride along under the
 * `__project__/` prefix inside the snapshot directory and restore back
 * to the project directory, so a snapshot brings the whole project
 * back, not just its `.orchestra` half. Only files the registry knows
 * (base `project`, not a directory) are included — never an arbitrary
 * project file — and snapshots stay local (never git-tracked), so no
 * secret can leak through them. A restore never trusts the manifest
 * alone — it verifies every listed file exists and parses before it
 * touches anything, so a broken snapshot fails with the current files
 * intact. Restore never deletes a file that exists now but not in the
 * snapshot; it reports it as skipped, so a restore can never silently
 * eat work done after the snapshot was taken.
 */

export const SnapshotManifest = Schema.Struct({
  version: Schema.Literal(1),
  createdAt: Schema.String,
  label: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
  /** Project-base files (rel to the project dir) held under `__project__/`; absent on old snapshots. */
  projectFiles: Schema.optional(Schema.Array(Schema.String)),
})
export type SnapshotManifest = typeof SnapshotManifest.Type

export interface SnapshotResult {
  readonly name: string
  readonly files: ReadonlyArray<string>
  /** Project-base files the snapshot holds (rel to the project dir). */
  readonly projectFiles: ReadonlyArray<string>
}

export interface RestoreResult {
  readonly restored: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<string>
  /** Project-base files restored to the project dir. */
  readonly restoredProjectFiles: ReadonlyArray<string>
}

/** How many snapshots to keep; older ones are pruned on creation. */
export const SNAPSHOT_KEEP = 7

/** Prefix inside a snapshot directory for project-base files (rel to the project dir, not `.orchestra/`). */
export const PROJECT_FILES_PREFIX = "__project__"

const snapshotDir = (directory: string, name: string): string =>
  ProjectFilesPaths.writePath(directory, path.join(ProjectFilesPaths.SNAPSHOTS_DIR, name))

const projectSnapshotPath = (directory: string, name: string, rel: string): string =>
  path.join(snapshotDir(directory, name), PROJECT_FILES_PREFIX, rel)

/** Text parses as the file kind its extension claims (YAML/JSON/JSONL); anything else is opaque text. */
const parsesText = (rel: string, text: string): boolean => {
  try {
    if (rel.endsWith(".yaml") || rel.endsWith(".yml")) Bun.YAML.parse(text)
    else if (rel.endsWith(".json")) JSON.parse(text)
    else if (rel.endsWith(".jsonl")) {
      for (const line of text.split("\n").filter((entry) => entry.trim() !== "")) JSON.parse(line)
    }
    return true
  } catch {
    return false
  }
}

const snapshotName = (stamp: string, label?: string): string =>
  label === undefined ? stamp : `${stamp}-${label.replace(/[^a-zA-Z0-9-_]+/g, "-")}`

const listFiles = (directory: string): Effect.Effect<ReadonlyArray<string>, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const index = yield* ProjectFilesIndex.generateIndex(directory)
    const files = index.entries
      .filter((entry) => entry.path !== `${ProjectFilesPaths.SNAPSHOTS_DIR}/`)
      .map((entry) => entry.path)
    // The index itself and health.json are generated files; include them
    // so a restore brings the project back whole.
    const extras = [ProjectFilesPaths.INDEX_FILE, ProjectFilesPaths.HEALTH_FILE]
    for (const extra of extras) {
      if (!files.includes(extra)) {
        const exists = yield* ProjectFilesFormat.exists(ProjectFilesPaths.readPath(directory, extra))
        if (exists) files.push(extra)
      }
    }
    return files.sort()
  })

/**
 * Project-base state files present on disk: every registered descriptor
 * with base `project` that is a file (not a directory) and exists.
 * Today that is only `native-skills/skills.json`; the registry drives
 * the list, so a future base-`project` file joins snapshots without a
 * code change here. Directories are never snapshotted file-by-file —
 * only registered single files, so a stray file in the project root
 * (`.env`, a key, a checkout) can never ride along.
 */
export const listProjectFiles = (
  directory: string,
): Effect.Effect<ReadonlyArray<string>, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const present: Array<string> = []
    for (const descriptor of ProjectFilesRegistry.allDescriptors()) {
      if (descriptor.base !== "project" || descriptor.dir) continue
      const exists = yield* ProjectFilesFormat.exists(
        ProjectFilesPaths.writePath(directory, descriptor.rel, "project"),
      )
      if (exists) present.push(descriptor.rel)
    }
    return present.sort()
  })

/** Creates a snapshot of the whole `.orchestra` directory plus the registered project-base state files, and prunes older ones past the keep limit. */
export const createSnapshot = (
  directory: string,
  options?: { label?: string },
): Effect.Effect<SnapshotResult, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const name = snapshotName(stamp, options?.label)
    const target = snapshotDir(directory, name)
    yield* ProjectFilesFormat.ensureDir(target)
    const files = yield* listFiles(directory)
    const projectFiles = yield* listProjectFiles(directory)
    for (const rel of files) {
      const source = ProjectFilesPaths.readPath(directory, rel)
      const dest = path.join(target, rel)
      yield* ProjectFilesFormat.ensureDir(path.dirname(dest))
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(source),
        catch: (error) => ProjectFilesErrors.writeFailed(rel, `cannot snapshot ${rel}: ${String(error)}`),
      })
      yield* ProjectFilesFormat.writeText(dest, bytes.toString("utf8"))
    }
    for (const rel of projectFiles) {
      const source = ProjectFilesPaths.readPath(directory, rel, "project")
      const dest = projectSnapshotPath(directory, name, rel)
      yield* ProjectFilesFormat.ensureDir(path.dirname(dest))
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(source),
        catch: (error) => ProjectFilesErrors.writeFailed(rel, `cannot snapshot ${rel}: ${String(error)}`),
      })
      yield* ProjectFilesFormat.writeText(dest, bytes.toString("utf8"))
    }
    const manifest: SnapshotManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      ...(options?.label === undefined ? {} : { label: options.label }),
      files: [...files],
      ...(projectFiles.length === 0 ? {} : { projectFiles: [...projectFiles] }),
    }
    yield* ProjectFilesFormat.writeJson(path.join(target, ProjectFilesPaths.SNAPSHOT_MANIFEST), manifest)
    yield* pruneSnapshots(directory)
    return { name, files, projectFiles }
  })

export const listSnapshots = (directory: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise({
    try: () => readdir(ProjectFilesPaths.writePath(directory, ProjectFilesPaths.SNAPSHOTS_DIR)).then((names) => names.sort()),
    catch: (error) => error,
  }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)))

const readManifest = (
  directory: string,
  name: string,
): Effect.Effect<SnapshotManifest, ProjectFilesErrors.ProjectFileError> =>
  ProjectFilesFormat.readJson(path.join(snapshotDir(directory, name), ProjectFilesPaths.SNAPSHOT_MANIFEST), SnapshotManifest)

/**
 * Restores a snapshot. Verifies the manifest and every listed file
 * (exists and parses, `.orchestra` files and project-base files alike)
 * BEFORE writing anything; on any verification failure the current
 * files are untouched. Files that exist now but not in the snapshot
 * are left alone and reported as skipped.
 */
export const restoreSnapshot = (
  directory: string,
  name: string,
): Effect.Effect<RestoreResult, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const manifest = yield* readManifest(directory, name).pipe(
      Effect.mapError((error) =>
        ProjectFilesErrors.restoreFailed(name, `snapshot ${name} is unusable: ${error.message}`)
      ),
    )
    const projectFiles = manifest.projectFiles ?? []
    // Verify first: every listed file must exist in the snapshot and
    // parse, so a corrupt snapshot cannot half-restore the project.
    for (const rel of manifest.files) {
      const snapshotFile = path.join(snapshotDir(directory, name), rel)
      const exists = yield* ProjectFilesFormat.exists(snapshotFile)
      if (!exists) {
        return yield* Effect.fail(
          ProjectFilesErrors.restoreFailed(name, `snapshot ${name} is missing ${rel} from its manifest`),
        )
      }
      const text = yield* ProjectFilesFormat.readText(snapshotFile)
      if (!parsesText(rel, text)) {
        return yield* Effect.fail(
          ProjectFilesErrors.restoreFailed(name, `snapshot ${name} holds a broken ${rel}; nothing was restored`),
        )
      }
    }
    for (const rel of projectFiles) {
      const snapshotFile = projectSnapshotPath(directory, name, rel)
      const exists = yield* ProjectFilesFormat.exists(snapshotFile)
      if (!exists) {
        return yield* Effect.fail(
          ProjectFilesErrors.restoreFailed(name, `snapshot ${name} is missing ${rel} from its manifest`),
        )
      }
      const text = yield* ProjectFilesFormat.readText(snapshotFile)
      if (!parsesText(rel, text)) {
        return yield* Effect.fail(
          ProjectFilesErrors.restoreFailed(name, `snapshot ${name} holds a broken ${rel}; nothing was restored`),
        )
      }
    }
    const skipped: Array<string> = []
    const current = yield* listFiles(directory)
    for (const rel of current) {
      if (!manifest.files.includes(rel)) skipped.push(rel)
    }
    const currentProjectFiles = yield* listProjectFiles(directory)
    for (const rel of currentProjectFiles) {
      if (!projectFiles.includes(rel)) skipped.push(rel)
    }
    for (const rel of manifest.files) {
      const source = path.join(snapshotDir(directory, name), rel)
      const dest = ProjectFilesPaths.writePath(directory, rel)
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(source),
        catch: (error) => ProjectFilesErrors.restoreFailed(name, `cannot read ${rel} from snapshot ${name}: ${String(error)}`),
      })
      yield* ProjectFilesFormat.writeText(dest, bytes.toString("utf8"))
    }
    for (const rel of projectFiles) {
      const source = projectSnapshotPath(directory, name, rel)
      const dest = ProjectFilesPaths.writePath(directory, rel, "project")
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(source),
        catch: (error) => ProjectFilesErrors.restoreFailed(name, `cannot read ${rel} from snapshot ${name}: ${String(error)}`),
      })
      yield* ProjectFilesFormat.writeText(dest, bytes.toString("utf8"))
    }
    return { restored: [...manifest.files], skipped, restoredProjectFiles: [...projectFiles] }
  })

/** Deletes snapshots past the keep limit, oldest first. */
export const pruneSnapshots = (directory: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const names = yield* listSnapshots(directory)
    const excess = names.slice(0, Math.max(0, names.length - SNAPSHOT_KEEP))
    for (const name of excess) {
      yield* Effect.tryPromise({ try: () => rm(snapshotDir(directory, name), { recursive: true, force: true }), catch: (error) => error }).pipe(
        Effect.catch(() => Effect.void),
      )
    }
  })
