export * as ProcessSkills from "./process-skills.js"

import { createHash } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { Orchestra } from "@orchestra/schema/orchestra"
import type { KV } from "./kv.js"

export const PREFIX = "orchestra/process-skills/"
export interface Context {
  sessionID: string
  agent: string
}
export type Target = { kind: "project" } | { kind: "role"; role: string } | { kind: "session"; sessionID: string }
export interface Binding {
  id: string
  dependencies: string[]
  targets: Target[]
}
export interface Registry {
  version: 1
  projectID: string
  skills: Binding[]
}
export const namespace = (projectID: string) =>
  `process-${createHash("sha256").update(projectID).digest("hex").slice(0, 16)}-`
export const reserved = (id: string) => id.startsWith("process-")
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value)
const decodeProject = Schema.decodeUnknownOption(Orchestra.Project)

export function parse(value: unknown, projectID: string): Registry | undefined {
  if (
    !record(value) ||
    !exact(value, ["version", "projectID", "skills"]) ||
    value.version !== 1 ||
    value.projectID !== projectID ||
    !Array.isArray(value.skills) ||
    value.skills.length > 200
  )
    return
  const prefix = namespace(projectID)
  const skills: Binding[] = []
  for (const item of value.skills) {
    if (
      !record(item) ||
      !exact(item, ["id", "dependencies", "targets"]) ||
      typeof item.id !== "string" ||
      !item.id.startsWith(prefix) ||
      !/^[1-9][0-9]{0,2}$/.test(item.id.slice(prefix.length)) ||
      !Array.isArray(item.dependencies) ||
      item.dependencies.length > 200 ||
      !item.dependencies.every(identifier) ||
      new Set(item.dependencies).size !== item.dependencies.length ||
      !Array.isArray(item.targets) ||
      item.targets.length > 300
    )
      return
    const targets: Target[] = []
    for (const target of item.targets) {
      if (!record(target)) return
      if (target.kind === "project" && exact(target, ["kind"])) targets.push({ kind: "project" })
      else if (target.kind === "role" && exact(target, ["kind", "role"]) && identifier(target.role))
        targets.push({ kind: "role", role: target.role })
      else if (target.kind === "session" && exact(target, ["kind", "sessionID"]) && identifier(target.sessionID))
        targets.push({ kind: "session", sessionID: target.sessionID })
      else return
    }
    skills.push({ id: item.id, dependencies: item.dependencies, targets })
  }
  const byID = new Map(skills.map((skill) => [skill.id, skill]))
  if (byID.size !== skills.length || skills.some((skill) => skill.dependencies.some((id) => !byID.has(id)))) return
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    if (!byID.get(id)!.dependencies.every(visit)) return false
    visiting.delete(id)
    visited.add(id)
    return true
  }
  if (!skills.every((skill) => visit(skill.id))) return
  return { version: 1, projectID, skills }
}

/** Internal installation primitive. Assignment is not permission to run a script or a tool. */
export const install = Effect.fn("ProcessSkills.install")(function* (kv: KV.Interface, registry: Registry) {
  const valid = parse(registry, registry.projectID)
  if (!valid) return yield* Effect.die(new Error("Invalid project skill assignments"))
  const project = decodeProject(yield* kv.get("orchestra/project/" + registry.projectID))
  if (Option.isNone(project) || project.value.id !== registry.projectID)
    return yield* Effect.die(new Error("Project does not exist"))
  yield* kv.atomicUpdate(PREFIX + registry.projectID, (current) => {
    if (current !== undefined) throw new Error("Project skill assignments already exist; nothing was overwritten")
    return JSON.parse(JSON.stringify(valid))
  })
})

const projectReady = Effect.fnUntraced(function* (kv: KV.Interface, projectID: string) {
  const project = decodeProject(yield* kv.get("orchestra/project/" + projectID))
  if (Option.isNone(project) || project.value.id !== projectID) return false
  const receiptID = yield* kv.get("orchestra/project-import/" + projectID)
  if (receiptID === undefined) return true
  if (typeof receiptID !== "string") return false
  const receipt = yield* kv.get("orchestra/template-import/" + receiptID)
  return record(receipt) && receipt.phase === "published" && receipt.projectID === projectID
})

/** Only explicit ownership or the project's exact main session counts, never a directory. */
export const selection = Effect.fn("ProcessSkills.selection")(function* (kv: KV.Interface, context?: Context) {
  const result = new Set<string>()
  if (!context) return undefined
  const owner = yield* kv.get("orchestra/owner/" + context.sessionID)
  let projectID: string | undefined
  if (owner !== undefined) {
    if (typeof owner !== "string") return undefined
    projectID = owner
  } else {
    let after: string | undefined
    do {
      const page = yield* kv.scan({ prefix: "orchestra/project/", after, limit: 1000 })
      for (const entry of page.entries) {
        const project = decodeProject(entry.value)
        if (
          Option.isSome(project) &&
          project.value.main === context.sessionID &&
          entry.key === "orchestra/project/" + project.value.id
        ) {
          if (projectID) return undefined
          projectID = project.value.id
        }
      }
      after = page.next
    } while (after)
  }
  if (!projectID || !(yield* projectReady(kv, projectID))) return undefined
  const registry = parse(yield* kv.get(PREFIX + projectID), projectID)
  if (!registry) return undefined
  const byID = new Map(registry.skills.map((skill) => [skill.id, skill]))
  const add = (id: string) => {
    if (result.has(id)) return
    result.add(id)
    byID.get(id)!.dependencies.forEach(add)
  }
  for (const skill of registry.skills) {
    if (
      skill.targets.some(
        (target) =>
          target.kind === "project" ||
          (target.kind === "role" && target.role === context.agent) ||
          (target.kind === "session" && target.sessionID === context.sessionID),
      )
    )
      add(skill.id)
  }
  return { projectID, registry, allowed: result }
})

export const allowed = Effect.fn("ProcessSkills.allowed")(function* (kv: KV.Interface, context?: Context) {
  return (yield* selection(kv, context))?.allowed ?? new Set<string>()
})
