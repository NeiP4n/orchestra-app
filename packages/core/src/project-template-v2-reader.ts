import { templateStage, TemplateStageError } from "./project-template-errors.js"
export * as ProjectTemplateV2Reader from "./project-template-v2-reader.js"

import { Effect } from "effect"
import { Orchestra } from "@orchestra/schema/orchestra"
import { ProjectTemplateReader as Reader } from "./project-template-reader.js"
import { ProjectTemplateV2Source as Source } from "./project-template-v2-source.js"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"

/** All adapters are passive owner reads, not repair/create, shell, browser or transcript reads. */
export interface Stores extends Reader.Stores {
  roles: () => Promise<readonly V2.Role[]>
  playbook: (projectID: string) => Promise<{ text: string | null; recommendedRoles: string[] }>
  /** Owning skill reader resolves project/session registry assignments and dependency definitions.
   * File paths are local inputs to the reader only and never enter exported bytes. */
  skills: (input: { projectID: string; sessionIDs: readonly string[] }) => Promise<{
    definitions: readonly { id: string; name: string; description?: string; autoinvoke?: boolean; root: string; entry: string; files: readonly string[]; dependencies: string[] }[]
    assignments: Source.ProcessSource["skillAssignments"]
  }>
  programs: (projectID: string) => Promise<V2.Process["programs"]>
}
export async function capture(
  stores: Stores,
  projectID: string,
  metadata: Parameters<typeof Source.capture>[1],
  linked: Parameters<typeof Reader.readSource>[2],
) {
  // Two complete reads bind all source definitions, not only project identity. The confirming
  // operator must repeat capture and bind this canonical digest again before saving.
  const once = async () => {
    const source = await templateStage("source-read", () => Effect.runPromise(Reader.readSource(stores, projectID, linked)))
    const sessionModels = await templateStage("session-models", async () => {
    const sessionModels: Source.ProcessSource["sessionModels"] = []
    for (const row of source.sessions) {
      const info = await Effect.runPromise(stores.getSession(row.id))
      if (!info || info.id !== row.id) throw Error("Session configuration changed during process capture.")
      const keys = [Orchestra.SessionModelsMetadataKey, "opencode-pp:worker-models"]
      const present = keys.some((key) => Object.hasOwn(info.metadata ?? {}, key))
      const refs = Orchestra.sessionModels(info.metadata)
      // Invalid metadata must not turn into a valid empty fallback list.
      if (present && !keys.some((key) => {
        const value = info.metadata?.[key]
        return Array.isArray(value) && value.length === refs.length && value.every((v, i) => {
          const r = refs[i]
          return !!v && typeof v === "object" && !Array.isArray(v) && v.providerID === r?.providerID && v.id === r.id && v.variant === r.variant
        })
      })) throw Error("Session fallback model metadata is damaged.")
      sessionModels.push({ sessionID: row.id, models: refs.map((m) => ({ provider: m.providerID, id: m.id, variant: m.variant ?? null })) })
    }
    return sessionModels
    })
    const [roles, playbook, inventory, programs] = await Promise.all([templateStage("roles", stores.roles), templateStage("playbook", () => stores.playbook(projectID)), templateStage("skills", () => stores.skills({ projectID, sessionIDs: source.sessions.map((s) => s.id) })), templateStage("programs", () => stores.programs(projectID))])
    const selected = await templateStage("skill-graph", async () => {
    const byID = new Map(inventory.definitions.map((s) => [s.id, s]))
    if (byID.size !== inventory.definitions.length) throw Error("Skill definitions are ambiguous.")
    const selected = new Set<string>(), visiting = new Set<string>()
    const select = (id: string) => {
      if (visiting.has(id)) throw Error("Skill dependencies contain a cycle.")
      if (selected.has(id)) return
      const skill = byID.get(id)
      if (!skill) throw Error("An assigned skill definition is missing.")
      visiting.add(id); skill.dependencies.forEach(select); visiting.delete(id); selected.add(id)
    }
    inventory.assignments.forEach((a) => a.skills.forEach(select))
    return selected
    })
    const skills: V2.Skill[] = []
    for (const item of inventory.definitions.filter((s) => selected.has(s.id))) {
      const { root, files, ...definition } = item
      skills.push({ ...definition, files: await templateStage("skill-files", () => Source.readSkillFiles(root, files)) })
    }
    const result = Source.capture(source, metadata, { playbook: playbook.text, recommendedRoles: playbook.recommendedRoles, roles, skills, skillAssignments: inventory.assignments, sessionModels, programs })
    if (!result.ok) throw new TemplateStageError(result.diagnostic?.stage ?? "process-schema", new Error(result.error), result.diagnostic?.reasonCode)
    return result.value
  }
  const first = await once(), second = await once()
  if (first.digest !== second.digest) throw new TemplateStageError("source-stability", new Error("Process definitions changed during capture. Review them again."))
  return second
}
