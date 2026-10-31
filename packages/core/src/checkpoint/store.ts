// The blob store behind the checkpoint engine. Every distinct file content is written once as a zstd
// object named after its hash; a manifest in index.json points at those hashes. Writing a snapshot is
// then a handful of small writes plus one atomic rename, and an unchanged file costs a stat, not a copy.

import fs from "node:fs"
import path from "node:path"
import { CheckpointError, type GcReport, type Index } from "./types.js"

export const VERSION = 1
export const FOLDER = path.join(".orchestra", "checkpoints")
const OBJECTS = "objects"
const INDEX = "index.json"

export const layout = (root: string) => ({
  folder: path.join(root, FOLDER),
  objects: path.join(root, FOLDER, OBJECTS),
  index: path.join(root, FOLDER, INDEX),
})

export interface StoredObject {
  readonly hash: string
  /** Uncompressed size. */
  readonly size: number
  /** Size on disk after zstd. */
  readonly stored: number
  /** False when an identical object was already stored. */
  readonly fresh: boolean
}

export function putObject(root: string, data: Uint8Array): StoredObject {
  const hash = Bun.hash(data).toString(16)
  const file = objectPath(root, hash)
  if (fs.existsSync(file)) return { hash, size: data.length, stored: fs.statSync(file).size, fresh: false }

  const packed = Bun.zstdCompressSync(data)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeAtomic(file, packed)
  return { hash, size: data.length, stored: packed.length, fresh: true }
}

export function getObject(root: string, hash: string): Uint8Array {
  const file = objectPath(root, hash)
  if (!fs.existsSync(file))
    throw new CheckpointError(
      "missing",
      `checkpoint object ${hash} is missing; run gc only after the snapshots that use it are deleted`,
    )
  return Bun.zstdDecompressSync(fs.readFileSync(file))
}

export function hasObject(root: string, hash: string) {
  return fs.existsSync(objectPath(root, hash))
}

export function readIndex(root: string): Index {
  const file = layout(root).index
  if (!fs.existsSync(file)) return { version: VERSION, moments: [] }
  const raw = fs.readFileSync(file, "utf8").trim()
  if (raw === "") throw new CheckpointError("corrupt", `${layout(root).index} is empty`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CheckpointError("corrupt", `${layout(root).index} is not valid JSON`)
  }
  return decodeIndex(parsed)
}

export function writeIndex(root: string, index: Index) {
  fs.mkdirSync(layout(root).folder, { recursive: true })
  writeAtomic(
    layout(root).index,
    new TextEncoder().encode(JSON.stringify({ version: VERSION, moments: index.moments })),
  )
}

/** Deletes objects no snapshot refers to. Snapshots themselves are removed with `remove`. */
export function collectGarbage(root: string): GcReport {
  const used = new Set(
    readIndex(root).moments.flatMap((moment) => moment.files.flatMap((file) => (file.hash ? [file.hash] : []))),
  )
  const directory = layout(root).objects
  if (!fs.existsSync(directory)) return { removed: 0, kept: 0 }

  let removed = 0
  let kept = 0
  for (const name of fs.readdirSync(directory)) {
    const hash = name.endsWith(".zst") ? name.slice(0, -4) : undefined
    if (hash === undefined) continue
    if (used.has(hash)) {
      kept++
      continue
    }
    fs.rmSync(path.join(directory, name), { force: true })
    removed++
  }
  return { removed, kept }
}

function objectPath(root: string, hash: string) {
  return path.join(layout(root).objects, `${hash}.zst`)
}

function writeAtomic(file: string, data: Uint8Array) {
  const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    fs.writeFileSync(temporary, data)
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

// The index is written by this module only, but it lives on disk through crashes and hand edits, so it is
// decoded once here instead of trusting the shape at every read site.
function decodeIndex(raw: unknown): Index {
  if (typeof raw !== "object" || raw === null) throw new CheckpointError("corrupt", "checkpoint index is not an object")
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.moments)) throw new CheckpointError("corrupt", "checkpoint index has no moments array")
  return {
    version: typeof record.version === "number" ? record.version : VERSION,
    moments: record.moments.map(decodeMoment),
  }
}

function decodeMoment(raw: unknown): Index["moments"][number] {
  if (typeof raw !== "object" || raw === null) throw new CheckpointError("corrupt", "checkpoint entry is not an object")
  const record = raw as Record<string, unknown>
  if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.created !== "number")
    throw new CheckpointError("corrupt", "checkpoint entry is missing its id, name or creation time")
  if (!Array.isArray(record.files)) throw new CheckpointError("corrupt", `checkpoint ${record.id} has no files array`)
  return {
    id: record.id,
    name: record.name,
    created: record.created,
    bytes: typeof record.bytes === "number" ? record.bytes : 0,
    stored: typeof record.stored === "number" ? record.stored : 0,
    files: record.files.map((file) => decodeFile(record.id as string, file)),
  }
}

function decodeFile(momentID: string, raw: unknown): Index["moments"][number]["files"][number] {
  if (typeof raw !== "object" || raw === null)
    throw new CheckpointError("corrupt", `checkpoint ${momentID} has a malformed file entry`)
  const record = raw as Record<string, unknown>
  if (typeof record.path !== "string" || typeof record.kind !== "string")
    throw new CheckpointError("corrupt", `checkpoint ${momentID} has a file entry without a path or kind`)
  return {
    path: record.path,
    kind: record.kind as Index["moments"][number]["files"][number]["kind"],
    ...(typeof record.from === "string" ? { from: record.from } : {}),
    ...(typeof record.hash === "string" ? { hash: record.hash } : {}),
    ...(typeof record.size === "number" ? { size: record.size } : {}),
  }
}
