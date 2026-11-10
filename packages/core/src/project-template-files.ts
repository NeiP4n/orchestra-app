export * as ProjectTemplateFiles from "./project-template-files.js"

import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, realpath, rm, rename } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Flock } from "@orchestra/util/flock"
import { ProjectTemplate } from "./project-template.js"

export const FILE = "template.json"
function leaf(name: string) { if (!/^[a-z][a-z0-9_-]{0,59}$/.test(name)) throw Error("Select a simple template name."); return name }
async function root(directory: string) {
  if (!path.isAbsolute(directory)) throw Error("Select an absolute destination folder.")
  const actual = await realpath(directory), info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || path.resolve(directory) !== actual) throw Error("Template folders must not use symbolic links.")
  return actual
}
async function child(parent: string, name: string) {
  const target = path.join(parent, name)
  try { await mkdir(target, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) throw Error("Template folders must not use symbolic links.")
  return target
}

export interface Codec<T extends { text: string; digest: string }> {
  MAX_BYTES: number
  preview: (serialized: string) => ProjectTemplate.Result<T>
}
/** Source folders contain exactly one configuration file. Never recursively copy a project.
 * The codec is selected by application code, never by imported content. */
export async function loadWithCodec<T extends { text: string; digest: string }>(directory: string, codec: Codec<T>) {
  const source = await root(directory), files = await readdir(source)
  if (files.length !== 1 || files[0] !== FILE) throw Error("A template folder must contain only template.json. Nothing was imported.")
  const target = path.join(source, FILE), before = await lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > codec.MAX_BYTES) throw Error("Template must be a bounded regular file, not a link.")
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev || actual.size > codec.MAX_BYTES) throw Error("Template changed while being opened.")
    const buffer = Buffer.alloc(codec.MAX_BYTES + 1), result = await handle.read(buffer, 0, buffer.length, 0)
    if (result.bytesRead > codec.MAX_BYTES) throw Error("Template exceeds the size limit.")
    const preview = codec.preview(buffer.subarray(0, result.bytesRead).toString('utf8'))
    if (!preview.ok) throw Error(preview.error)
    if (await realpath(source) !== source || (await readdir(source)).length !== 1) throw Error("Template folder changed during review.")
    return preview.value
  } finally { await handle.close() }
}

/** Atomic create-if-absent for the manifest. A pre-existing folder is never reused or replaced. */
export async function saveWithCodec<T extends { text: string; digest: string }>(directory: string, name: string, serialized: string, reviewedDigest: string, codec: Codec<T>) {
  const preview = codec.preview(serialized)
  if (!preview.ok) throw Error(preview.error)
  if (reviewedDigest !== preview.value.digest) throw Error("Template changed after preview. Review the current bytes again.")
  const parent = await root(directory), destination = path.join(parent, leaf(name))
  // mkdir is the create-only reservation; a second save/import cannot overwrite even an empty existing folder.
  await mkdir(destination, { mode: 0o700 })
  const reservation = await lstat(destination)
  try {
    const handle = await open(path.join(destination, FILE), 'wx', 0o600)
    try { await handle.writeFile(preview.value.text, 'utf8'); await handle.sync() } finally { await handle.close() }
    const verified = await loadWithCodec(destination, codec)
    if (verified.digest !== reviewedDigest) throw Error("Template failed verification after writing.")
    return { directory: destination, digest: verified.digest }
  } catch (error) {
    const current = await lstat(destination).catch(() => undefined)
    if (current && !current.isSymbolicLink() && current.ino === reservation.ino && current.dev === reservation.dev) await rm(destination, { recursive: true, force: true })
    throw error
  }
}
/** Explicit reviewed replacement of one existing library manifest. Never creates a second template.
 * Same-ID writers share the lock. Both old and new canonical bytes are bound by the caller's review. */
export async function replaceWithCodec<T extends { text: string; digest: string }>(directory: string, serialized: string, previousDigest: string, reviewedDigest: string, codec: Codec<T>) {
  const next = codec.preview(serialized)
  if (!next.ok) throw Error(next.error)
  if (next.value.digest !== reviewedDigest) throw Error("Template changed after preview. Review it again.")
  const destination = await root(directory)
  return Flock.withLock("template-manifest:" + destination, async () => {
    const prior = await loadWithCodec(destination, codec)
    if (prior.digest === reviewedDigest) return { directory: destination, digest: reviewedDigest }
    if (prior.digest !== previousDigest) throw Error("Template changed after preview. Review it again.")
    const target = path.join(destination, FILE), before = await lstat(target)
    const parent = await root(path.dirname(destination))
    const temporary = path.join(parent, ".template-update-" + randomUUID())
    let created = false
    try {
      const handle = await open(temporary, "wx", 0o600)
      created = true
      try { await handle.writeFile(next.value.text, "utf8"); await handle.sync() } finally { await handle.close() }
      // Do not replace a file/folder that moved or changed while new bytes were written.
      const latest = await loadWithCodec(destination, codec), current = await lstat(target)
      if (latest.digest !== previousDigest || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink() || await realpath(destination) !== destination)
        throw Error("Template changed after preview. Review it again.")
      await rename(temporary, target)
      created = false
      const verified = await loadWithCodec(destination, codec)
      if (verified.digest !== reviewedDigest) throw Error("Template failed verification after replacement.")
      return { directory: destination, digest: verified.digest }
    } finally { if (created) await rm(temporary, { force: true }) }
  })
}
// Keep the v1 API and return types intact. v2 must opt into its own closed codec explicitly.
export const load = (directory: string) => loadWithCodec(directory, ProjectTemplate)
export const save = (directory: string, name: string, serialized: string, reviewedDigest: string) =>
  saveWithCodec(directory, name, serialized, reviewedDigest, ProjectTemplate)

function releaseVersion(value: string) {
  // Prerelease compatibility needs product policy, so it fails closed here rather than guessing ordering.
  if (!/^\d+\.\d+\.\d+(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(value)) throw Error("A stable Orchestra version is required for compatibility review.")
  // SemVer build metadata identifies the binary, not version precedence.
  return value.split('+')[0].split('.').map(Number)
}
export function checkCompatibility(bundle: ProjectTemplate.Bundle, installedVersion: string) {
  const installed = releaseVersion(installedVersion), required = releaseVersion(bundle.minOrchestraVersion)
  for (let index = 0; index < 3; index++) {
    if (installed[index] > required[index]) return
    if (installed[index] < required[index]) throw Error("Template requires a newer Orchestra version. Nothing was imported.")
  }
}
export function checklist(bundle: ProjectTemplate.Bundle) {
  return {
    state: 'review-required' as const,
    localVaultSlots: bundle.vault.local.map((entry) => ({ name: entry.name, type: entry.type, label: entry.label, state: 'empty' as const })),
    globalVaultSlots: bundle.vault.globalRequirements.map((name) => ({ name, state: 'binding-required' as const })),
    sessions: bundle.sessions.map((entry) => ({ slot: entry.slot, state: 'role-model-review-required' as const })),
    browsers: bundle.browsers.map((entry) => ({ slot: entry.slot, state: 'not-opened-login-required' as const })),
    schedules: bundle.schedules.map((entry) => ({ slot: entry.slot, state: 'paused-destination-validation-required' as const })),
    rules: 'review-before-applying' as const,
    integrations: 'credentials-and-permissions-review-required' as const,
    active: false as const,
  }
}

/** Stages definitions in a separate folder, never touches the live project stores or starts services. */
export async function stage(source: string, projectDirectory: string, name: string, reviewedDigest: string, installedVersion: string) {
  const preview = await load(source)
  if (preview.digest !== reviewedDigest) throw Error("Template changed after preview. Review the current bytes again.")
  checkCompatibility(preview.bundle, installedVersion)
  const project = await root(projectDirectory), orchestra = await child(project, '.orchestra'), imports = await child(orchestra, 'template-imports')
  const saved = await save(imports, name, preview.text, reviewedDigest)
  return { ...saved, checklist: checklist(preview.bundle) }
}

/** Update review only. Conflicts never mutate a live project or silently replace its definitions. */
export function compare(existing: ProjectTemplate.Bundle, incoming: ProjectTemplate.Bundle) {
  const sections = ['sessions', 'browsers', 'schedules', 'providers', 'mcp', 'rules', 'localVault', 'globalVault', 'metadata'] as const
  const rows = (bundle: ProjectTemplate.Bundle, section: typeof sections[number]): readonly unknown[] => {
    if (section === 'localVault') return bundle.vault.local
    if (section === 'globalVault') return bundle.vault.globalRequirements.map((name) => ({ name }))
    if (section === 'metadata') return [{ name: 'metadata', title: bundle.name, description: bundle.description, minOrchestraVersion: bundle.minOrchestraVersion, variables: bundle.variables, mainSession: bundle.mainSession ?? null }]
    return bundle[section]
  }
  const key = (entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object') throw Error('Invalid update review entry.')
    return 'slot' in entry ? String(entry.slot) : 'id' in entry ? String(entry.id) : 'name' in entry ? String(entry.name) : `rule_${index + 1}`
  }
  return sections.flatMap((section) => {
    const prior = new Map(rows(existing, section).map((entry, index) => [key(entry, index), entry]))
    const next = rows(incoming, section), keys = new Set(next.map(key))
    const result = next.map((entry, index) => ({ section, slot: key(entry, index), status: !prior.has(key(entry, index)) ? 'add' as const : JSON.stringify(prior.get(key(entry, index))) === JSON.stringify(entry) ? 'unchanged' as const : 'conflict' as const }))
    return [...result, ...[...prior.keys()].filter((name) => !keys.has(name)).map((name) => ({ section, slot: name, status: 'preserve-existing' as const }))]
  })
}
