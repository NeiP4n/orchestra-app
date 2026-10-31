// Building and updating the graph.
//
// The file list comes from `git ls-files`, which already knows what is tracked and what the project
// ignores, with a directory walk as the fallback for a folder that is not a repository. Re-indexing is
// incremental: a file whose size and modification time still match what was stored is not even read,
// and one whose content hash still matches only has its timestamp refreshed. Changed files are written
// in batches inside one transaction, so an interrupted run leaves the previous graph intact.

import fs from "node:fs"
import path from "node:path"
import { counts, deleteFile, fingerprints, open, readMeta, replaceFile, touchFile, writeMeta } from "./db.js"
import { extractFile } from "./extract.js"
import type { Edge, ExtractedFile, IndexReport } from "./types.js"

const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])
const SKIPPED = new Set([
  ".cache",
  ".git",
  ".next",
  ".orchestra",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp",
  "vendor",
])
const MAX_BYTES = 1_500_000
const BATCH = 50
// Bumped whenever the extractor learns something new: a database from an older extractor is rebuilt.
const VERSION = "6"

export interface IndexOptions {
  /** Re-extract every file, even when the fingerprint says it did not change. */
  readonly force?: boolean
  /** Restrict the run to these repository-relative files. */
  readonly files?: readonly string[]
}

export function listFiles(root: string): string[] {
  const git = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const listed = git.exitCode === 0 ? new TextDecoder().decode(git.stdout).split("\0").filter(Boolean) : walk(root)
  return [...new Set(listed)].filter(indexable).sort()
}

export function indexProject(root: string, options: IndexOptions = {}): IndexReport {
  const started = Date.now()
  const graph = open(root)
  try {
    const known = fingerprints(graph)
    // A database written by an older extractor cannot be trusted: its rows describe a different
    // understanding of the same source, so every file is read again.
    const force = options.force === true || readMeta(graph, "version") !== VERSION
    const listed = [...(options.files ?? listFiles(root))]
    const current = new Set(listed)
    let unchanged = 0
    let indexed = 0
    let removed = 0

    let writes: (() => void)[] = []
    const flush = () => {
      if (writes.length === 0) return
      const pending = writes
      writes = []
      graph.db.transaction(() => pending.forEach((write) => write()))()
    }

    for (const file of listed) {
      const absolute = path.join(root, file)
      const stat = safeStat(absolute)
      if (!stat || stat.size > MAX_BYTES) {
        if (known.has(file)) {
          deleteFile(graph, file)
          removed++
        }
        continue
      }

      const mtimeMs = Math.floor(stat.mtimeMs)
      const previous = known.get(file)
      if (!force && previous && previous.mtimeMs === mtimeMs && previous.size === stat.size) {
        unchanged++
        continue
      }

      const source = readText(absolute)
      if (source === undefined) continue
      const hash = Bun.hash(source).toString(16)
      if (!force && previous && previous.hash === hash) {
        const record = { path: file, mtimeMs, size: stat.size, hash }
        writes.push(() => touchFile(graph, record))
        unchanged++
        if (writes.length >= BATCH) flush()
        continue
      }

      const extracted = extractFile(file, source)
      const record = { path: file, mtimeMs, size: stat.size, hash }
      const edges = resolveImports(file, extracted, current)
      writes.push(() => replaceFile(graph, record, extracted.symbols, edges))
      indexed++
      if (writes.length >= BATCH) flush()
    }
    flush()

    const stale = [...known.keys()].filter((file) => !current.has(file))
    if (stale.length > 0) {
      graph.db.transaction(() => stale.forEach((file) => deleteFile(graph, file)))()
      removed += stale.length
    }

    writeMeta(graph, "version", VERSION)
    writeMeta(graph, "indexed_at", String(Date.now()))
    const totals = counts(graph)
    return {
      root,
      database: graph.file,
      files: listed.length,
      indexed,
      removed,
      unchanged,
      symbols: totals.symbols,
      edges: totals.edges,
      milliseconds: Date.now() - started,
    }
  } finally {
    graph.db.close()
  }
}

export function graphExists(root: string) {
  return fs.existsSync(path.join(root, ".orchestra", "codegraph.db"))
}

function indexable(file: string) {
  const normalized = file.replaceAll("\\", "/")
  if (normalized.endsWith(".d.ts")) return false
  if (!EXTENSIONS.has(path.extname(normalized).toLowerCase())) return false
  return !normalized.split("/").some((segment) => SKIPPED.has(segment))
}

// A folder that git does not know: walk it, skipping the same directories the index never wants.
function walk(root: string): string[] {
  const found: string[] = []
  const stack = [""]
  while (stack.length > 0) {
    const relative = stack.pop()!
    const entries = readDirectory(path.join(root, relative))
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) stack.push(next)
        continue
      }
      found.push(next)
    }
  }
  return found
}

function readDirectory(directory: string) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

function safeStat(file: string) {
  try {
    return fs.statSync(file)
  } catch {
    return undefined
  }
}

function readText(file: string) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

// An import that points at a file of the project is stored as that repository-relative path, so
// "who imports this module" is one indexed lookup. Anything else keeps its specifier.
function resolveImports(file: string, extracted: ExtractedFile, current: Set<string>): Edge[] {
  return extracted.edges.flatMap((edge) => {
    if (edge.kind !== "import") return [edge]
    const target = resolveSpecifier(file, edge.dst, current)
    return target === undefined ? [edge] : [{ ...edge, dst: target }]
  })
}

function resolveSpecifier(from: string, specifier: string, current: Set<string>) {
  if (specifier.startsWith(".")) return probe(path.posix.dirname(from), specifier, current)
  // A workspace import names a package, not a path: `@orchestra/core/federation` is
  // packages/core/src/federation.ts of this repository.
  const workspace = /^@orchestra\/([^/]+)(?:\/(.*))?$/.exec(specifier)
  if (workspace) return probe(`packages/${workspace[1]}/src`, workspace[2] ?? "index", current)
  return undefined
}

function probe(from: string, specifier: string, current: Set<string>) {
  const base = path.posix.normalize(path.posix.join(from, specifier))
  const candidates = [base, ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((ext) => `${base}.${ext}`)]
  for (const candidate of candidates) if (current.has(candidate)) return candidate
  for (const ext of ["ts", "tsx", "js", "jsx"]) {
    const index = `${base}/index.${ext}`
    if (current.has(index)) return index
  }
  return undefined
}
