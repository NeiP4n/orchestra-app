import { TemplateStageError, templateCapture, templateDiagnosticOf } from "./project-template-errors.js"
export * as ProjectTemplateV2 from "./project-template-v2.js"

import { createHash } from "node:crypto"
import { ProjectTemplate as V1 } from "./project-template.js"
import { countSecrets } from "./memory/scrub.js"

/** Process definitions only. A valid document is NOT a permission grant or an executable import plan. */
export type Model = NonNullable<V1.Bundle["sessions"][number]["model"]>
export interface Role {
  agent: string
  name: string
  description: string
  rules: string
  category: string
  readOnly: boolean
  mode?: string
  model?: string
  models?: string[]
  variant?: string
  tools?: string[]
  autoTools?: boolean
  hub?: string[]
  registry?: string[]
}
export interface Skill {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  entry: string
  /** Includes SKILL.md and every required text reference/script. No source-machine paths. */
  files: { path: string; content: string; sha256: string }[]
  dependencies: string[]
}
export interface Process {
  playbook: string | null
  recommendedRoles: string[]
  /** Missing source definitions are archived as references, never executable roles. */
  unresolvedRoles?: string[]
  roles: Role[]
  skills: Skill[]
  skillAssignments: { target: { kind: "project" } | { kind: "role"; role: string } | { kind: "session"; session: string }; skills: string[] }[]
  sessionModels: { session: string; models: Model[] }[]
  programs: { id: string; reason: string }[]
}
export interface Bundle extends Omit<V1.Bundle, "version"> { version: 2; process: Process }
export const MAX_BYTES = 1_048_576
export const MAX_FILES = 200
export const hash = (text: string) => createHash("sha256").update(text).digest("hex")
function invalid(): never { throw Error("Invalid process template or unsupported fields.") }
const has = (v: unknown, key: string) => !!v && typeof v === "object" && Object.hasOwn(v, key)
function object(value: unknown, required: string[], optional: string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  const row = value as Record<string, unknown>
  if (required.some((key) => !Object.hasOwn(row, key)) || Object.keys(row).some((key) => ![...required, ...optional].includes(key))) invalid()
  return row
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid()
  return value
}
function text(value: unknown, max = 65536, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || Buffer.byteLength(value) > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid()
  if (countSecrets(value) || /[?&](?:token|key|api[-_]?key|secret|password|signature)=[^&#\s]+/i.test(value) || /--?(?:api[-_]?key|token|password|secret)(?:=|\s+)\S+/i.test(value)) throw Error("Secret-like value detected. No template was prepared.")
  if (/(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/)[^\s<>,;]*)/.test(value)) throw Error("Absolute paths are not portable. No template was prepared.")
  return value
}
function id(value: unknown) {
  const s = text(value, 120)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(s)) invalid()
  return s
}
function modelReference(value: unknown) {
  const s = text(value, 160)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*(?:#[A-Za-z0-9_.-]+)?$/.test(s)) invalid()
  return s
}
function unique(values: string[]) { if (new Set(values).size !== values.length) invalid(); return values }
const ids = (value: unknown, max = 100) => unique(list(value, max).map(id))
function bool(value: unknown) { if (typeof value !== "boolean") invalid(); return value }
export function relativePath(value: unknown) {
  const s = text(value, 180)
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(s) || s.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".") || part.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || /(?:^|\/)(?:credentials?|secrets?|id_rsa|id_ed25519|passwords?)(?:[./_-]|$)/i.test(s)) invalid()
  return s
}
function model(value: unknown): Model {
  const r = object(value, ["provider", "id", "variant"])
  return { provider: id(r.provider), id: id(r.id), variant: r.variant === null ? null : id(r.variant) }
}
/** Closed portable skill definitions, shared by the template codec and persistent owner store. */
export function parseSkills(value: unknown): Skill[] {
  const skills = list(value, 100).map((value): Skill => {
    const r = object(value, ["id", "name", "entry", "files", "dependencies"], ["description", "autoinvoke"])
    const files = list(r.files, MAX_FILES).map((file) => {
      const f = object(file, ["path", "content", "sha256"]), content = text(f.content, 65536, true)
      if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256) || hash(content) !== f.sha256) invalid()
      return { path: relativePath(f.path), content, sha256: f.sha256 }
    })
    const paths = unique(files.map((f) => f.path.toLowerCase()))
    if (paths.some((file) => paths.some((other) => other.startsWith(file + "/")))) invalid()
    const entry = relativePath(r.entry)
    if (!files.some((f) => f.path === entry)) invalid()
    return { id: id(r.id), name: text(r.name, 160), entry, files, dependencies: ids(r.dependencies), ...(has(r, "description") ? { description: text(r.description, 4096, true) } : {}), ...(has(r, "autoinvoke") ? { autoinvoke: bool(r.autoinvoke) } : {}) }
  })
  const skillIDs = new Set(unique(skills.map((r) => r.id)))
  if (skills.reduce((n, r) => n + r.files.length, 0) > MAX_FILES || skills.some((r) => r.dependencies.some((d) => d === r.id || !skillIDs.has(d)))) invalid()
  const visiting = new Set<string>(), visited = new Set<string>(), byID = new Map(skills.map((s) => [s.id, s]))
  const visit = (key: string) => { if (visiting.has(key)) invalid(); if (visited.has(key)) return; visiting.add(key); byID.get(key)!.dependencies.forEach(visit); visiting.delete(key); visited.add(key) }
  skills.forEach((s) => visit(s.id))
  return skills
}
function parseProcess(raw: unknown, base: V1.Bundle): Process {
  const p = object(raw, ["playbook", "recommendedRoles", "roles", "skills", "skillAssignments", "sessionModels", "programs"], ["unresolvedRoles"])
  const roles = templateCapture("process-roles", () => list(p.roles, 100).map((value): Role => {
    const r = object(value, ["agent", "name", "description", "rules", "category", "readOnly"], ["mode", "model", "models", "variant", "tools", "autoTools", "hub", "registry"])
    return {
      agent: id(r.agent), name: text(r.name, 160), description: text(r.description, 4096, true), rules: text(r.rules, 65536, true), category: text(r.category, 160), readOnly: bool(r.readOnly),
      ...(has(r, "mode") ? { mode: id(r.mode) } : {}), ...(has(r, "model") ? { model: modelReference(r.model) } : {}),
      ...(has(r, "models") ? { models: unique(list(r.models, 30).map(modelReference)) } : {}), ...(has(r, "variant") ? { variant: id(r.variant) } : {}),
      ...(has(r, "tools") ? { tools: unique(list(r.tools, 200).map((v) => text(v, 120))) } : {}),
      ...(has(r, "autoTools") ? { autoTools: bool(r.autoTools) } : {}), ...(has(r, "hub") ? { hub: ids(r.hub) } : {}), ...(has(r, "registry") ? { registry: ids(r.registry) } : {}),
    }
  }))
  const definedRoles = new Set(unique(roles.map((r) => r.agent)))
  const unresolvedRoles = has(p, "unresolvedRoles") ? ids(p.unresolvedRoles) : []
  if (unresolvedRoles.some(role => definedRoles.has(role))) invalid()
  const roleIDs = new Set([...definedRoles, ...unresolvedRoles])
  if (base.sessions.some((r) => r.role !== null && !roleIDs.has(r.role)) || base.rules.some((r) => r.scope === "role" && !roleIDs.has(r.role!))) invalid()
  const recommendedRoles = templateCapture("process-playbook", () => ids(p.recommendedRoles))
  if (recommendedRoles.some((r) => !roleIDs.has(r))) invalid()
  const skills = templateCapture("process-skills", () => parseSkills(p.skills))
  const skillIDs = new Set(skills.map((r) => r.id))
  const sessions = new Set(base.sessions.map((s) => s.slot))
  const targets = new Set<string>()
  const skillAssignments = templateCapture("process-assignments", () => list(p.skillAssignments, 300).map((value): Process["skillAssignments"][number] => {
    const r = object(value, ["target", "skills"]), kind = (r.target as { kind?: unknown } | null)?.kind
    let target: Process["skillAssignments"][number]["target"]
    if (kind === "project") { object(r.target, ["kind"]); target = { kind } }
    else if (kind === "role") { const t = object(r.target, ["kind", "role"]), role = id(t.role); if (!roleIDs.has(role)) invalid(); target = { kind, role } }
    else if (kind === "session") { const t = object(r.target, ["kind", "session"]), session = id(t.session); if (!sessions.has(session)) invalid(); target = { kind, session } }
    else invalid()
    const key = JSON.stringify(target); if (targets.has(key)) invalid(); targets.add(key)
    const assigned = ids(r.skills); if (assigned.some((s) => !skillIDs.has(s))) invalid()
    return { target, skills: assigned }
  }))
  const sessionModels = templateCapture("process-models", () => list(p.sessionModels, 100).map((value) => { const r = object(value, ["session", "models"]), session = id(r.session); if (!sessions.has(session)) invalid(); const models = list(r.models, 30).map(model); unique(models.map((m) => JSON.stringify(m))); return { session, models } }))
  unique(sessionModels.map((r) => r.session))
  if (sessionModels.length !== sessions.size) invalid()
  const referencedRoles = new Set([
    ...base.sessions.flatMap(s => s.role === null ? [] : [s.role]),
    ...base.rules.flatMap(r => r.scope === "role" ? [r.role!] : []),
    ...recommendedRoles,
    ...skillAssignments.flatMap(a => a.target.kind === "role" ? [a.target.role] : []),
  ])
  if (roleIDs.size > 100 || unresolvedRoles.some(role => !referencedRoles.has(role))) invalid()
  const programs = templateCapture("process-programs", () => list(p.programs, 100).map((value) => { const r = object(value, ["id", "reason"]); return { id: id(r.id), reason: text(r.reason, 1024) } })); unique(programs.map((r) => r.id))
  return { ...(unresolvedRoles.length ? { unresolvedRoles } : {}), playbook: p.playbook === null ? null : templateCapture("process-playbook", () => text(p.playbook)), recommendedRoles, roles, skills, skillAssignments, sessionModels, programs }
}
/** v1 reader remains untouched. No runtime path accepts v2 until the reviewed installer exists. */
export function parse(serialized: string): V1.Result<Bundle> {
  if (Buffer.byteLength(serialized) > MAX_BYTES) return { ok: false, error: "Process template exceeds the size limit." }
  try {
    const raw = JSON.parse(serialized) as Record<string, unknown>
    if (!raw || typeof raw !== "object" || raw.version !== 2 || !has(raw, "process")) invalid()
    const { process, ...base } = raw
    const parsed = V1.parse(JSON.stringify({ ...base, version: 1 }))
    if (!parsed.ok) throw new TemplateStageError(parsed.diagnostic?.stage ?? "base-schema", new Error(parsed.error), parsed.diagnostic?.reasonCode)
    return { ok: true, value: { ...parsed.value, version: 2, process: parseProcess(process, parsed.value) } }
  } catch (error) { return { ok: false, diagnostic: templateDiagnosticOf(error) ?? { stage: "process-schema", reasonCode: "schema-invalid" }, error: "Invalid process template or unsupported fields. Nothing was imported." } }
}
export function preview(serialized: string) {
  const parsed = parse(serialized); if (!parsed.ok) return parsed
  const text = JSON.stringify(parsed.value, null, 2) + "\n"
  if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false as const, diagnostic: undefined, error: "Formatted process template exceeds the size limit." }
  return { ok: true as const, value: { bundle: parsed.value, text, digest: hash(text), counts: { roles: parsed.value.process.roles.length, skills: parsed.value.process.skills.length, files: parsed.value.process.skills.reduce((n, s) => n + s.files.length, 0) }, requiresReviewedInstaller: true as const, startsAutomatically: false as const } }
}
