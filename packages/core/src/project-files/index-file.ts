export * as ProjectFilesIndex from "./index-file.js"

import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { ProjectFilesErrors } from "./errors.js"
import { ProjectFilesFormat } from "./format.js"
import { ProjectFilesPaths } from "./paths.js"
import { ProjectFilesRegistry } from "./registry.js"

/**
 * The index (`index.yaml`) is the manifest of `.orchestra`: every file,
 * what it holds, when it changed. It exists because the audit found
 * files no agent could discover — only the DoD and the memory blocks
 * reach the prompt, so `notes/`, `plots/`, `skills/` and the rest were
 * invisible. An agent reads the index first and then knows everything
 * the project already has.
 *
 * Rules: the index never lists itself (its own hash would always be
 * stale); the `snapshots/` subtree is one entry with a count, not one
 * entry per file inside every snapshot; an unregistered file is listed
 * as `unknown` — visible, never hidden — so the next sync either
 * registers it or the health check flags it.
 */

export const IndexEntry = Schema.Struct({
  path: Schema.String,
  kind: Schema.String,
  purpose: Schema.String,
  updatedAt: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  count: Schema.optional(Schema.Number),
})
export type IndexEntry = typeof IndexEntry.Type

export const IndexFile = Schema.Struct({
  version: Schema.Literal(1),
  projectId: Schema.optional(Schema.String),
  generatedAt: Schema.String,
  entries: Schema.Array(IndexEntry),
})
export type IndexFile = typeof IndexFile.Type

export const INDEX_VERSION = 1 as const

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

interface WalkedFile {
  readonly rel: string
  readonly abs: string
}

/** All files under `.orchestra`, relative paths with `/`. Skips the index itself and the inside of `snapshots/`. */
const walkFiles = (dir: string, base: string): Effect.Effect<ReadonlyArray<WalkedFile>, ProjectFilesErrors.ProjectFileError> =>
  Effect.tryPromise({
    try: async () => {
      const out: Array<WalkedFile> = []
      const walk = async (current: string): Promise<void> => {
        const entries = await readdir(current, { withFileTypes: true })
        for (const entry of entries) {
          const abs = path.join(current, entry.name)
          const rel = path.relative(base, abs).split(path.sep).join("/")
          if (entry.isDirectory()) {
            if (rel === ProjectFilesPaths.SNAPSHOTS_DIR) continue
            await walk(abs)
          } else if (entry.isFile()) {
            if (rel === ProjectFilesPaths.INDEX_FILE) continue
            out.push({ rel, abs })
          }
        }
      }
      await walk(dir).catch(() => undefined)
      return out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
    },
    catch: (error) => ProjectFilesErrors.missing(base, `cannot scan ${base}: ${String(error)}`),
  })

const countSnapshots = (directory: string): Effect.Effect<number> =>
  Effect.tryPromise({
    try: () => readdir(ProjectFilesPaths.writePath(directory, ProjectFilesPaths.SNAPSHOTS_DIR)).then((names) => names.length),
    catch: (error) => error,
  }).pipe(Effect.catch(() => Effect.succeed(0)))

const entryFor = (file: WalkedFile, updatedAt: string, size: number, hash: string): IndexEntry => {
  const descriptor = ProjectFilesRegistry.descriptorFor(file.rel)
  return {
    path: file.rel,
    kind: descriptor?.kind ?? "unknown",
    purpose: descriptor?.purpose ?? "Unregistered file — add a descriptor or remove it",
    updatedAt,
    size,
    sha256: hash,
  }
}

/** Builds the index from the directory on disk. Never fails on an unknown file — it lists it as `unknown`. */
export const generateIndex = (
  directory: string,
  projectId?: string,
): Effect.Effect<IndexFile, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const dir = ProjectFilesPaths.orchestraDir(directory)
    const files = yield* walkFiles(dir, dir)
    const entries: Array<IndexEntry> = []
    for (const file of files) {
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(file.abs),
        catch: (error) => ProjectFilesErrors.missing(file.rel, `cannot read ${file.rel}: ${String(error)}`),
      })
      const info = yield* Effect.tryPromise({
        try: () => stat(file.abs),
        catch: (error) => ProjectFilesErrors.missing(file.rel, `cannot stat ${file.rel}: ${String(error)}`),
      })
      entries.push(entryFor(file, info.mtime.toISOString(), info.size, sha256(bytes)))
    }
    const snapshots = yield* countSnapshots(directory)
    const snapshotsDescriptor = ProjectFilesRegistry.descriptorFor(`${ProjectFilesPaths.SNAPSHOTS_DIR}/`)
    entries.push({
      path: `${ProjectFilesPaths.SNAPSHOTS_DIR}/`,
      kind: snapshotsDescriptor?.kind ?? "snapshot",
      purpose: snapshotsDescriptor?.purpose ?? "Point-in-time copies of .orchestra for rollback",
      updatedAt: new Date().toISOString(),
      size: 0,
      sha256: "",
      count: snapshots,
    })
    entries.sort((a, b) => (a.path < b.path ? -1 : 1))
    return {
      version: INDEX_VERSION,
      ...(projectId === undefined ? {} : { projectId }),
      generatedAt: new Date().toISOString(),
      entries,
    }
  })

/** Reads the index. A missing index is an empty index (fresh project), never an error. A corrupt one fails loudly. */
export const readIndex = (directory: string): Effect.Effect<IndexFile, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const file = ProjectFilesPaths.readPath(directory, ProjectFilesPaths.INDEX_FILE)
    const exists = yield* ProjectFilesFormat.exists(file)
    if (!exists) {
      return { version: INDEX_VERSION, generatedAt: new Date(0).toISOString(), entries: [] }
    }
    return yield* ProjectFilesFormat.readYaml(file, IndexFile)
  })

export const writeIndex = (directory: string, index: IndexFile): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  ProjectFilesFormat.writeYaml(ProjectFilesPaths.writePath(directory, ProjectFilesPaths.INDEX_FILE), index)

/** Regenerates the index from disk and writes it. Returns the fresh index. */
export const refreshIndex = (directory: string, projectId?: string): Effect.Effect<IndexFile, ProjectFilesErrors.ProjectFileError> =>
  generateIndex(directory, projectId).pipe(Effect.tap((index) => writeIndex(directory, index)))
