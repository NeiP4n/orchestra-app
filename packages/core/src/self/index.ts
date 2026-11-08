export * as SelfIndex from "./index.js"

// The self index: one rebuilt-on-change document store that lets the agent
// answer "what can Orchestra itself do" — its commands, config keys,
// environment variables, tools, extension points, docs, and the operator's
// own added files — plus a door into the code graph of Orchestra's own
// checkout for symbol-level questions.
//
// Freshness is a fingerprint, not a timer: the version define, plus the size
// and modification time of every file the collectors read, plus the operator's
// custom paths. Boot calls `ensureFresh`; a fingerprint mismatch rebuilds in
// one transaction, so an update (new version, new files) reindexes on the
// next start and a fresh check costs one stat per harvested file.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { collect, harvestedFiles } from "./sources.js"
import type { SelfDoc } from "./sources.js"
import { count, open, readMeta, replaceAll, search, supported, writeMeta } from "./store.js"
import type { Hit, Store } from "./store.js"

// The version the build stamped in; a dev checkout has no define and falls
// back to the harvested files alone. Same guarded-define pattern as
// filesystem/watcher-binding.ts.
declare const ORCHESTRA_VERSION: string | undefined

export interface Options {
  /** Operator-added documents from `self_index.paths`. */
  readonly customPaths?: readonly string[]
  /** Include AI_ATLAS.md / AGENTS.md sections (default true). */
  readonly docs?: boolean
}

export interface Status {
  readonly available: boolean
  readonly reason?: string
  readonly root?: string
  readonly database?: string
  readonly documents?: number
  readonly fingerprint?: string
  readonly fresh?: boolean
}

export interface Rebuilt {
  readonly documents: number
  readonly fingerprint: string
  readonly durationMs: number
}

/**
 * Orchestra's own source root, resolved from this module's location like the
 * source updater does (cli/src/services/source-release.ts). Undefined when
 * this process is not running from an Orchestra source tree — the node
 * artifact bundles these files away — and callers must say so honestly
 * instead of indexing whatever directory they were started in.
 */
export function selfRoot(): string | undefined {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
    const manifest = path.join(root, "package.json")
    if (!fs.existsSync(manifest)) return undefined
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown }
    if (parsed.name !== "orchestra") return undefined
    return root
  } catch {
    return undefined
  }
}

/** FNV-1a over the version and every harvested file's size and mtime: cheap, stable, order-independent. */
export function fingerprint(root: string, options: Options = {}): string {
  const parts = [
    typeof ORCHESTRA_VERSION === "string" ? ORCHESTRA_VERSION : "dev",
    `docs=${options.docs === false ? 0 : 1}`,
    ...(options.customPaths ?? []),
  ]
  for (const file of harvestedFiles(root)) {
    try {
      const stat = fs.statSync(path.join(root, file))
      parts.push(`${file}:${stat.size}:${Math.round(stat.mtimeMs)}`)
    } catch {
      parts.push(`${file}:missing`)
    }
  }
  for (const added of options.customPaths ?? []) {
    try {
      const stat = fs.statSync(added)
      parts.push(`custom:${added}:${stat.size}:${Math.round(stat.mtimeMs)}`)
    } catch {
      parts.push(`custom:${added}:missing`)
    }
  }
  parts.sort()
  let hash = 0x811c9dc5
  for (const part of parts) {
    for (let index = 0; index < part.length; index++) {
      hash ^= part.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0xff
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

export function status(dataDir: string, options: Options = {}): Status {
  if (!supported()) return { available: false, reason: "the self index needs the Bun sqlite engine" }
  const root = selfRoot()
  if (!root) return { available: false, reason: "this build does not run from an Orchestra source tree" }
  const store = open(dataDir)
  try {
    const current = readMeta(store, "fingerprint")
    const wanted = fingerprint(root, options)
    return {
      available: true,
      root,
      database: store.file,
      documents: count(store),
      fingerprint: current,
      fresh: current === wanted,
    }
  } finally {
    store.db.close()
  }
}

export function rebuild(dataDir: string, options: Options = {}): Rebuilt {
  const started = Date.now()
  const root = selfRoot()
  if (!root) throw new Error("self index rebuild refused: this build does not run from an Orchestra source tree")
  const docs: SelfDoc[] = collect(root, options)
  const store = open(dataDir)
  try {
    const written = replaceAll(store, docs)
    const mark = fingerprint(root, options)
    writeMeta(store, "fingerprint", mark)
    writeMeta(store, "rebuiltAt", new Date().toISOString())
    return { documents: written, fingerprint: mark, durationMs: Date.now() - started }
  } finally {
    store.db.close()
  }
}

/** Rebuild only when the fingerprint moved; returns what it did for logging. */
export function ensureFresh(dataDir: string, options: Options = {}): { rebuilt: boolean; documents: number } {
  const root = selfRoot()
  if (!root || !supported()) return { rebuilt: false, documents: 0 }
  const wanted = fingerprint(root, options)
  const store = open(dataDir)
  const current = readMeta(store, "fingerprint")
  const documents = count(store)
  store.db.close()
  if (current === wanted && documents > 0) return { rebuilt: false, documents }
  const result = rebuild(dataDir, options)
  return { rebuilt: true, documents: result.documents }
}

export function searchDocs(store: Store, query: string, limit?: number): Hit[] {
  return search(store, query, limit)
}

export function openStore(dataDir: string): Store {
  return open(dataDir)
}
