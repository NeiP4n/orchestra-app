export * as ProjectTemplateFiles from "./project-template-files.js"

import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
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

/** Source folders contain exactly one configuration file. Never recursively copy a project. */
export async function load(directory: string) {
  const source = await root(directory), files = await readdir(source)
  if (files.length !== 1 || files[0] !== FILE) throw Error("A template folder must contain only template.json. Nothing was imported.")
  const target = path.join(source, FILE), before = await lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > ProjectTemplate.MAX_BYTES) throw Error("Template must be a bounded regular file, not a link.")
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev || actual.size > ProjectTemplate.MAX_BYTES) throw Error("Template changed while being opened.")
    const buffer = Buffer.alloc(ProjectTemplate.MAX_BYTES + 1), result = await handle.read(buffer, 0, buffer.length, 0)
    if (result.bytesRead > ProjectTemplate.MAX_BYTES) throw Error("Template exceeds the size limit.")
    const preview = ProjectTemplate.preview(buffer.subarray(0, result.bytesRead).toString('utf8'))
    if (!preview.ok) throw Error(preview.error)
    if (await realpath(source) !== source || (await readdir(source)).length !== 1) throw Error("Template folder changed during review.")
    return preview.value
  } finally { await handle.close() }
}

/** Atomic create-if-absent for the manifest. A pre-existing folder is never reused or replaced. */
export async function save(directory: string, name: string, serialized: string, reviewedDigest: string) {
  const preview = ProjectTemplate.preview(serialized)
  if (!preview.ok) throw Error(preview.error)
  if (reviewedDigest !== preview.value.digest) throw Error("Template changed after preview. Review the current bytes again.")
  const parent = await root(directory), destination = path.join(parent, leaf(name))
  // mkdir is the create-only reservation; a second save/import cannot overwrite even an empty existing folder.
  await mkdir(destination, { mode: 0o700 })
  const reservation = await lstat(destination)
  try {
    const handle = await open(path.join(destination, FILE), 'wx', 0o600)
    try { await handle.writeFile(preview.value.text, 'utf8'); await handle.sync() } finally { await handle.close() }
    const verified = await load(destination)
    if (verified.digest !== reviewedDigest) throw Error("Template failed verification after writing.")
    return { directory: destination, digest: verified.digest }
  } catch (error) {
    const current = await lstat(destination).catch(() => undefined)
    if (current && !current.isSymbolicLink() && current.ino === reservation.ino && current.dev === reservation.dev) await rm(destination, { recursive: true, force: true })
    throw error
  }
}
function releaseVersion(value: string) {
  // Prerelease compatibility needs product policy, so it fails closed here rather than guessing ordering.
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw Error("A stable Orchestra version is required for compatibility review.")
  return value.split('.').map(Number)
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
