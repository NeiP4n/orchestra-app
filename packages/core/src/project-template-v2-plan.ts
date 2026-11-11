export * as ProjectTemplateV2Plan from "./project-template-v2-plan.js"

import { isDeepStrictEqual } from "node:util"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"
import { ProjectTemplateFiles } from "./project-template-files.js"
export interface Destination {
  projectID: string
  installedVersion: string
  reviewedDigest: string
  roles: readonly V2.Role[]
  skills: readonly V2.Skill[]
  models: ReadonlySet<string>
  programs: ReadonlySet<string>
  mcp: ReadonlyMap<string, { disabled: boolean }>
  providers: ReadonlySet<string>
}
const reserved = new Set(["orchestrator", "team-browser-agent"])
const modelKey = (m: V2.Model) => `${m.provider}/${m.id}${m.variant === null ? "" : "#" + m.variant}`
/** No writes. Source definitions and proposed local IDs are separate from access rights.
 * Even a conflict-free result cannot activate a role, skill, trigger, program or MCP. */
export function prepare(serialized: string, destination: Destination) {
  const preview = V2.preview(serialized)
  if (!preview.ok) throw Error(preview.error)
  if (preview.value.digest !== destination.reviewedDigest) throw Error("Process template changed after review.")
  if (!/^prj_[A-Za-z0-9_-]{1,100}$/.test(destination.projectID)) throw Error("Fresh destination project required.")
  ProjectTemplateFiles.checkCompatibility({ ...preview.value.bundle, version: 1 }, destination.installedVersion)
  if (new Set(destination.roles.map((r) => r.agent)).size !== destination.roles.length || new Set(destination.skills.map((s) => s.id)).size !== destination.skills.length) throw Error("Destination definitions are ambiguous.")
  const bundle = preview.value.bundle, namespace = V2.hash(destination.projectID).slice(0, 16)
  const roles = bundle.process.roles.map((definition, i) => {
    const existing = destination.roles.find((r) => r.agent === definition.agent), same = existing !== undefined && isDeepStrictEqual(existing, definition)
    const target = reserved.has(definition.agent) ? definition.agent : `team-process-${namespace}-${i + 1}`
    if (target !== definition.agent && destination.roles.some((r) => r.agent === target)) throw Error("Fresh project-local role identity is already occupied.")
    return { source: definition.agent, target, definition, existing: existing ? same ? "identical" as const : "different" as const : "absent" as const,
      action: reserved.has(definition.agent) ? same ? "reuse-core" as const : "blocked-core-difference" as const : "install-project-local" as const,
      access: "review-required" as const }
  })
  const skills = bundle.process.skills.map((definition, i) => {
    const existing = destination.skills.find((s) => s.id === definition.id), same = existing !== undefined && isDeepStrictEqual(existing, definition)
    const target = `process-${namespace}-${i + 1}`
    if (destination.skills.some((s) => s.id === target)) throw Error("Fresh project-local skill identity is already occupied.")
    return { source: definition.id, target, definition, existing: existing ? same ? "identical" as const : "different" as const : "absent" as const, action: "install-project-local" as const, execution: "review-required" as const }
  })
  const roleMap = new Map(roles.map((r) => [r.source, r.target])), skillMap = new Map(skills.map((s) => [s.source, s.target]))
  const role = (id: string) => { const target = roleMap.get(id); if (!target) throw Error("Incomplete role remap."); return target }
  const skill = (id: string) => { const target = skillMap.get(id); if (!target) throw Error("Incomplete skill remap."); return target }
  const models = new Set<string>()
  bundle.sessions.forEach((s) => { if (s.model) models.add(modelKey(s.model)) })
  bundle.process.sessionModels.forEach((s) => s.models.forEach((m) => models.add(modelKey(m))))
  bundle.process.roles.forEach((r) => { if (r.model) models.add(r.model); r.models?.forEach((m) => models.add(m)) })
  const requiredMcp = bundle.mcp.map((m) => ({ name: m.name, state: destination.mcp.has(m.name) ? destination.mcp.get(m.name)!.disabled ? "disabled" as const : "installed" as const : "missing" as const }))
  return {
    digest: preview.value.digest, projectID: destination.projectID,
    roles, skills,
    remapped: {
      sessions: bundle.sessions.map((s) => ({ ...s, role: s.role === null ? null : role(s.role) })),
      rules: bundle.rules.map((r) => r.scope === "role" ? { ...r, role: role(r.role!) } : r),
      recommendedRoles: bundle.process.recommendedRoles.map(role),
      skillAssignments: bundle.process.skillAssignments.map((r) => ({ target: r.target.kind === "role" ? { kind: "role" as const, role: role(r.target.role) } : r.target, skills: r.skills.map(skill) })),
      skillDependencies: skills.map((s) => ({ id: s.target, dependencies: s.definition.dependencies.map(skill) })),
    },
    requirements: {
      missingModels: [...models].filter((m) => !destination.models.has(m)),
      missingPrograms: bundle.process.programs.filter((p) => !destination.programs.has(p.id)).map((p) => p.id),
      missingProviders: bundle.providers.filter((p) => !destination.providers.has(p.id)).map((p) => p.id),
      mcp: requiredMcp,
      credentialSlots: [...bundle.vault.local.map((s) => s.name), ...bundle.vault.globalRequirements],
      browsersNeedSignIn: bundle.browsers.map((b) => b.slot),
      coreRoleDifferences: roles.filter((r) => r.action === "blocked-core-difference").map((r) => r.source),
    },
    permissionsGranted: false as const, overwritesExisting: false as const, startsAutomatically: false as const,
    activation: "blocked-until-reviewed-install-and-dependency-check" as const,
  }
}
