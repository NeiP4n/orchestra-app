export * as ProcessSkillDefinitions from "./process-skill-definitions.js"

import path from "node:path"
import { Effect, Exit } from "effect"
import type { KV } from "./kv.js"
import { ProcessSkills } from "./process-skills.js"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"
import { ProjectTemplateV2Source as Source } from "./project-template-v2-source.js"

export const PREFIX = "orchestra/process-skill-definitions/"
export interface Definition {
  skill: V2.Skill
  root: string
}
export interface Snapshot {
  version: 1
  projectID: string
  registryDigest: string
  definitions: Definition[]
}
const registryDigest = (registry: ProcessSkills.Registry) => V2.hash(JSON.stringify(registry))
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

export function preview(registry: ProcessSkills.Registry, input: unknown): { snapshot: Snapshot; digest: string } {
  const assignments = ProcessSkills.parse(registry, registry.projectID)
  if (!assignments || !Array.isArray(input) || input.length > 100) throw Error("Invalid project skill definitions")
  const rows = input.map((value) => {
    if (
      !record(value) ||
      !exact(value, ["skill", "root"]) ||
      typeof value.root !== "string" ||
      value.root.length > 4096 ||
      !path.isAbsolute(value.root) ||
      path.resolve(value.root) !== value.root
    )
      throw Error("Invalid project skill definitions")
    return { skill: value.skill, root: value.root }
  })
  const skills = V2.parseSkills(rows.map((row) => row.skill))
  if (Buffer.byteLength(JSON.stringify(skills)) > V2.MAX_BYTES || assignments.skills.length !== skills.length)
    throw Error("Invalid project skill definitions")
  const byID = new Map(assignments.skills.map((skill) => [skill.id, skill]))
  if (
    skills.some(
      (skill) =>
        !byID.has(skill.id) || JSON.stringify(skill.dependencies) !== JSON.stringify(byID.get(skill.id)!.dependencies),
    )
  )
    throw Error("Invalid project skill definitions")
  const snapshot: Snapshot = {
    version: 1,
    projectID: registry.projectID,
    registryDigest: registryDigest(assignments),
    definitions: skills.map((skill, i) => ({ skill, root: rows[i].root })),
  }
  return { snapshot, digest: V2.hash(JSON.stringify(snapshot)) }
}

async function verify(definition: Definition) {
  const files = await Source.readSkillFiles(
    definition.root,
    definition.skill.files.map((file) => file.path),
  )
  if (JSON.stringify(files) !== JSON.stringify(definition.skill.files))
    throw Error("Installed skill files changed; review them again")
}

/** Registers already materialized, reviewed files. This never writes files, executes scripts or grants permission. */
export const install = Effect.fn("ProcessSkillDefinitions.install")(function* (
  kv: KV.Interface,
  registry: ProcessSkills.Registry,
  input: readonly Definition[],
  reviewedDigest: string,
) {
  const reviewed = preview(registry, input)
  if (reviewed.digest !== reviewedDigest) return yield* Effect.die(new Error("Project skills changed after review"))
  const current = ProcessSkills.parse(yield* kv.get(ProcessSkills.PREFIX + registry.projectID), registry.projectID)
  if (!current || registryDigest(current) !== reviewed.snapshot.registryDigest)
    return yield* Effect.die(new Error("Project skill assignments changed after review"))
  yield* Effect.promise(async () => {
    for (const definition of reviewed.snapshot.definitions) await verify(definition)
  })
  yield* kv.atomicUpdate(PREFIX + registry.projectID, (value) => {
    if (value !== undefined) throw Error("Project skill definitions already exist; nothing was overwritten")
    return JSON.parse(JSON.stringify(reviewed.snapshot))
  })
})

/** Missing records preserve the assignment-only registration API; corrupt records never fall back to another source. */
export const load = Effect.fn("ProcessSkillDefinitions.load")(function* (
  kv: KV.Interface,
  selected: { projectID: string; registry: ProcessSkills.Registry; allowed: ReadonlySet<string> },
) {
  const value = yield* kv.get(PREFIX + selected.projectID)
  if (value === undefined) return [] as Definition[]
  try {
    if (
      !record(value) ||
      !exact(value, ["version", "projectID", "registryDigest", "definitions"]) ||
      value.version !== 1 ||
      value.projectID !== selected.projectID ||
      value.registryDigest !== registryDigest(selected.registry)
    )
      return undefined
    const checked = preview(selected.registry, value.definitions)
    const owned = checked.snapshot.definitions.filter((definition) => selected.allowed.has(definition.skill.id))
    const verified = yield* Effect.promise(async () => {
      for (const definition of owned) await verify(definition)
    }).pipe(Effect.exit)
    return Exit.isSuccess(verified) ? owned : undefined
  } catch {
    return undefined
  }
})
