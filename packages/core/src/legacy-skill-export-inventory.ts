export * as LegacySkillExportInventory from "./legacy-skill-export-inventory.js"

import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"
import { ProjectTemplateV2Source as Source } from "./project-template-v2-source.js"

export type Inventory = {
  state: "ready"
  version: 1
  root: string
  entry: string
  files: string[]
  dependencies: string[]
  entryDigest: string
  origin: { kind: "config-skill-file"; sourceDirectory: string; definitionPath: string }
} | { state: "invalid" }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
/** Explicit definition-only allowlist, owned by the existing file loader. No directory scan or inferred links.
 * The document supplies files/dependencies, never paths, assignments, authority or provenance. */
export function fromMetadata(metadata: unknown, directory: string, filepath: string, content: string): Inventory | undefined {
  if (!object(metadata) || !Object.hasOwn(metadata, "orchestra/export")) return undefined
  try {
    const value = metadata["orchestra/export"]
    if (!object(value) || Object.keys(value).sort().join() !== "dependencies,files,version" || value.version !== 1) throw Error()
    if (!path.isAbsolute(directory) || !path.isAbsolute(filepath)) throw Error()
    const relative = path.relative(directory, filepath)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw Error()
    const entry = path.basename(filepath)
    const files = value.files
    const dependencies = value.dependencies
    if (!Array.isArray(files) || files.length === 0 || files.length > V2.MAX_FILES || files.some(file => typeof file !== "string")) throw Error()
    files.forEach(V2.relativePath)
    if (!files.includes(entry) || new Set(files.map(file => file.toLowerCase())).size !== files.length) throw Error()
    if (!Array.isArray(dependencies) || dependencies.length > 100 || dependencies.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(id)) || new Set(dependencies).size !== dependencies.length) throw Error()
    return {
      state: "ready", version: 1, root: path.dirname(filepath), entry, files: [...files], dependencies: [...dependencies],
      entryDigest: V2.hash(content),
      origin: { kind: "config-skill-file", sourceDirectory: directory, definitionPath: filepath },
    }
  } catch { return { state: "invalid" } }
}

export interface Skill {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  path: string
  legacyExport?: Inventory
}
export interface Catalog { sessionID: string; directory: string; skills: readonly Skill[] }
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}
/** Catalog availability is not an invocation or permission grant. Only project-local file sources
 * are portable here. Global catalogs, inferred usage and chat contents are never selected. */
export async function collect(catalogs: readonly Catalog[]) {
  const definitions = new Map<string, { id: string; name: string; description?: string; autoinvoke?: boolean; root: string; entry: string; files: string[]; dependencies: string[] }>()
  const inventories = new Map<string, Inventory>()
  const assignments: Source.ProcessSource["skillAssignments"] = []
  const origins: { sessionID: string; skill: string; kind: "project-catalog-availability"; source: Inventory & { state: "ready" } }[] = []
  let complete = true
  const sessionIDs = new Set<string>()
  for (const catalog of catalogs) {
    if (!path.isAbsolute(catalog.directory) || sessionIDs.has(catalog.sessionID)) throw Error("Legacy skill catalog owner is ambiguous")
    sessionIDs.add(catalog.sessionID)
    const local = catalog.skills.filter(skill => !skill.id.startsWith("process-") && inside(catalog.directory, skill.path))
    if (new Set(local.map(skill => skill.id)).size !== local.length) throw Error("Legacy skill identities are ambiguous")
    const selected: string[] = []
    for (const skill of local) {
      const inventory = skill.legacyExport
      if (!inventory || inventory.state !== "ready") { complete = false; continue }
      if (inventory.origin.definitionPath !== skill.path || inventory.root !== path.dirname(skill.path) || inventory.entry !== path.basename(skill.path) || !inside(catalog.directory, inventory.origin.sourceDirectory))
        throw Error("Legacy skill provenance differs from its source owner")
      if (inventories.has(skill.id) && !isDeepStrictEqual(inventories.get(skill.id), inventory)) throw Error("Legacy skill definitions differ between sessions")
      const files = await Source.readSkillFiles(inventory.root, inventory.files)
      if (files.find(file => file.path === inventory.entry)?.sha256 !== inventory.entryDigest) throw Error("Legacy skill definition changed after discovery")
      const value = { id: skill.id, name: skill.name, ...(skill.description === undefined ? {} : { description: skill.description }), ...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }), root: inventory.root, entry: inventory.entry, files: [...inventory.files], dependencies: [...inventory.dependencies] }
      // Validate names, ids, bytes and dependency syntax through the same export codec. Dependencies
      // are checked across the complete inventory below rather than silently filled from globals.
      if (definitions.has(skill.id) && !isDeepStrictEqual(definitions.get(skill.id), value)) throw Error("Legacy skill metadata differs between sessions")
      definitions.set(skill.id, value); inventories.set(skill.id, inventory); selected.push(skill.id)
      origins.push({ sessionID: catalog.sessionID, skill: skill.id, kind: "project-catalog-availability", source: inventory })
    }
    const selectedIDs = new Set(selected)
    for (const id of selected) if (definitions.get(id)!.dependencies.some(dependency => !selectedIDs.has(dependency)))
      throw Error("Legacy skill dependency is not available in its source session")
    assignments.push({ target: { kind: "session", sessionID: catalog.sessionID }, skills: selected })
  }
  if (!complete) return { complete: false as const, definitions: [], assignments: [], origins: [] }
  const concrete = await Promise.all([...definitions.values()].map(async definition => ({ ...definition, files: await Source.readSkillFiles(definition.root, definition.files) })))
  V2.parseSkills(concrete.map(({ root: _, ...definition }) => definition))
  return { complete: true as const, definitions: [...definitions.values()], assignments, origins }
}
