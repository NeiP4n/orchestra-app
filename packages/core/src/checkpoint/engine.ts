// Save, list, preview and restore. A save reads only the paths git reports as changed, so a snapshot of a
// large checkout with a small edit costs one git status plus a few file reads. A restore writes the saved
// blobs back for exactly the paths the snapshot knows about and leaves everything else alone; it first
// saves the working tree as a safety snapshot, so the restore itself can be undone.

import fs from "node:fs"
import path from "node:path"
import { isRepository, readChanges } from "./changes.js"
import { collectGarbage, getObject, hasObject, putObject, readIndex, writeIndex } from "./store.js"
import {
  CheckpointError,
  type Change,
  type FileEntry,
  type GcReport,
  type Moment,
  type Preview,
  type PreviewFile,
  type RestoreReport,
} from "./types.js"

export interface SaveOptions {
  readonly name?: string
  /** Replace an existing snapshot with the same explicit name. */
  readonly force?: boolean
}

export interface RestoreOptions {
  /** Save the working tree first so the restore can itself be reverted. True by default. */
  readonly safety?: boolean
}

export function save(root: string, options: SaveOptions = {}): Moment {
  requireRepository(root)
  const index = readIndex(root)
  const name = options.name?.trim() ?? ""
  if (name !== "" && !options.force && index.moments.some((moment) => moment.name === name))
    throw new CheckpointError("exists", `a checkpoint named "${name}" already exists; pass force to replace it`)

  const moments = options.force && name !== "" ? index.moments.filter((moment) => moment.name !== name) : index.moments
  const changes = readChanges(root)
  const stored = new Map<string, number>()
  const files: FileEntry[] = []
  let bytes = 0

  for (const change of changes) {
    const entry = capture(root, change)
    if (entry === undefined) continue
    files.push(entry.file)
    if (entry.file.hash !== undefined) stored.set(entry.file.hash, entry.stored)
    bytes += entry.bytes
  }

  const moment: Moment = {
    id: createID(),
    name: name === "" ? `auto ${new Date().toISOString()}` : name,
    created: Date.now(),
    files,
    bytes,
    stored: [...stored.values()].reduce((total, size) => total + size, 0),
  }
  writeIndex(root, { version: index.version, moments: [...moments, moment] })
  return moment
}

export function list(root: string): Moment[] {
  return [...readIndex(root).moments].sort((left, right) => right.created - left.created)
}

export function find(root: string, idOrName: string): Moment {
  const moments = readIndex(root).moments
  const moment =
    moments.find((candidate) => candidate.id === idOrName) ?? moments.find((candidate) => candidate.name === idOrName)
  if (moment === undefined) throw new CheckpointError("missing", `no checkpoint matches "${idOrName}"`)
  return moment
}

export function preview(root: string, idOrName: string): Preview {
  requireRepository(root)
  const moment = find(root, idOrName)
  const known = new Set(moment.files.map((file) => file.path))
  const files = moment.files.map((file) => compare(root, file))
  const extra = readChanges(root)
    .map((change) => change.path)
    .filter((file) => !known.has(file))
  return {
    moment,
    files,
    extra,
    writes: files.filter((file) => file.action === "write").length,
    deletes: files.filter((file) => file.action === "delete").length,
    unchanged: files.filter((file) => file.action === "unchanged").length,
  }
}

export function restore(root: string, idOrName: string, options: RestoreOptions = {}): RestoreReport {
  requireRepository(root)
  const moment = find(root, idOrName)
  const plan = moment.files.map((entry) => ({ entry, action: compare(root, entry).action }))

  // A restore that would not change a byte takes no safety snapshot: there is nothing to lose.
  const pending = plan.filter((step) => step.action !== "unchanged")
  for (const step of pending)
    if (step.entry.hash !== undefined && !hasObject(root, step.entry.hash))
      throw new CheckpointError(
        "missing",
        `checkpoint ${moment.id} cannot restore ${step.entry.path}: object ${step.entry.hash} is missing`,
      )

  const safety =
    options.safety === false || pending.length === 0
      ? undefined
      : save(root, { name: `before-restore ${moment.id} ${new Date().toISOString()}` })

  let written = 0
  let deleted = 0
  let unchanged = 0
  for (const { entry, action } of plan) {
    const absolute = path.join(root, entry.path)
    if (action === "unchanged") {
      unchanged++
      continue
    }
    if (entry.kind === "renamed" && entry.from !== undefined && entry.from !== entry.path)
      fs.rmSync(path.join(root, entry.from), { force: true })
    if (entry.kind === "deleted") {
      fs.rmSync(absolute, { force: true })
      deleted++
      continue
    }
    if (entry.hash === undefined)
      throw new CheckpointError("corrupt", `checkpoint ${moment.id} has no content for ${entry.path}`)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    writeAtomic(absolute, getObject(root, entry.hash))
    written++
  }
  return { moment, written, deleted, unchanged, ...(safety === undefined ? {} : { safety: safety.id }) }
}

/** Removes one snapshot. Its blobs stay until gc collects what no other snapshot uses. */
export function remove(root: string, idOrName: string): Moment {
  const index = readIndex(root)
  const moment = find(root, idOrName)
  writeIndex(root, { version: index.version, moments: index.moments.filter((candidate) => candidate.id !== moment.id) })
  return moment
}

export function gc(root: string): GcReport {
  return collectGarbage(root)
}

// A path git reports may have vanished between the status call and the read: that is a race, not a
// snapshot worth failing over, so the file is simply not captured.
function capture(root: string, change: Change): { file: FileEntry; bytes: number; stored: number } | undefined {
  if (change.kind === "deleted")
    return {
      file: { path: change.path, kind: change.kind, ...(change.from === undefined ? {} : { from: change.from }) },
      bytes: 0,
      stored: 0,
    }
  const absolute = path.join(root, change.path)
  if (!fs.existsSync(absolute)) return undefined
  const data = fs.readFileSync(absolute)
  const object = putObject(root, data)
  return {
    file: {
      path: change.path,
      kind: change.kind,
      ...(change.from === undefined ? {} : { from: change.from }),
      hash: object.hash,
      size: data.length,
    },
    bytes: data.length,
    stored: object.stored,
  }
}

function compare(root: string, file: FileEntry): PreviewFile {
  const absolute = path.join(root, file.path)
  if (file.kind === "deleted")
    return {
      path: file.path,
      action: fs.existsSync(absolute) ? "delete" : "unchanged",
      ...(file.hash ? { savedHash: file.hash } : {}),
    }
  if (!fs.existsSync(absolute))
    return { path: file.path, action: "write", ...(file.hash ? { savedHash: file.hash } : {}) }
  const currentHash = Bun.hash(fs.readFileSync(absolute)).toString(16)
  return {
    path: file.path,
    action: currentHash === file.hash ? "unchanged" : "write",
    currentHash,
    ...(file.hash ? { savedHash: file.hash } : {}),
  }
}

function requireRepository(root: string) {
  if (!isRepository(root))
    throw new CheckpointError(
      "not-a-repository",
      `${root} is not a git repository; a checkpoint saves exactly what git reports as changed`,
    )
}

function createID() {
  return `cp_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`
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
