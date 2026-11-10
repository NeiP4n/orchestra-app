export * as ProjectTemplateV2OwnerReader from "./project-template-v2-owner-reader.js"

import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import { Orchestra as OrchestraSchema } from "@orchestra/schema/orchestra"
import { SessionID } from "@orchestra/schema/session-id"
import { AbsolutePath } from "./schema.js"
import type { KV } from "./kv.js"
import type { Session } from "@orchestra/schema/session"
import type { Model } from "@orchestra/schema/model"
import { ProjectTemplateV2Runtime as Runtime } from "./project-template-v2-runtime.js"
import { ProcessSkills } from "./process-skills.js"
import { ProcessSkillDefinitions as Definitions } from "./process-skill-definitions.js"
import { ProjectTemplateV2Reader as Reader } from "./project-template-v2-reader.js"
import type { ProjectTemplateV2Source as Source } from "./project-template-v2-source.js"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"

export interface Dependencies {
  kv: KV.Interface
  store: {
    get: (id: Session.ID) => Effect.Effect<Session.Info | undefined>
    getStoredModel: (id: Session.ID) => Effect.Effect<Model.Ref | undefined>
    list: (input: { directoryPrefix: AbsolutePath; parentID: null }) => Effect.Effect<readonly Session.Info[]>
  }
  orchestra: {
    roles: (id?: OrchestraSchema.ProjectID) => Effect.Effect<ReadonlyArray<OrchestraSchema.Role>>
    playbook: (id: OrchestraSchema.ProjectID) => Effect.Effect<{ name: string; text: string } | undefined>
  }
  /** The source-owning canonical reserved-role definitions, never inferred from generated prompts. */
  coreRoles: () => Promise<readonly V2.Role[]>
}
/** Passive live adapters. No repair/create, model, messages, browser pages, filesystem sweeps or secret values. */
export function make(deps: Dependencies, projectID: string): Reader.Stores {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const process = async () => {
    const marker = await run(deps.kv.get("orchestra/project-import/" + projectID))
    if (marker !== undefined) {
      if (typeof marker !== "string") throw Error("Project import marker is invalid")
      const receipt = await run(deps.kv.get("orchestra/template-import/" + marker))
      if (
        !receipt ||
        typeof receipt !== "object" ||
        Array.isArray(receipt) ||
        !("phase" in receipt) ||
        receipt.phase !== "published" ||
        !("projectID" in receipt) ||
        receipt.projectID !== projectID
      )
        throw Error("Project process import is not published")
    }
    const state = await run(Runtime.read(deps.kv, projectID))
    if (!state && (await run(deps.kv.get(Runtime.PROJECT_PROCESS + projectID))) !== undefined)
      throw Error("Project process snapshot is invalid; no partial v2 export was prepared")
    return state
  }
  const session = (id: string) =>
    Effect.gen(function* () {
      const info = yield* deps.store.get(SessionID.make(id))
      if (!info) return undefined
      return { ...info, model: yield* deps.store.getStoredModel(info.id) }
    })
  return {
    kv: deps.kv,
    getSession: session,
    listSessionsInTree: (directory) =>
      deps.store.list({ directoryPrefix: AbsolutePath.make(directory), parentID: null }),
    roles: async () => {
      await process()
      const core = await deps.coreRoles()
      if (
        core.some((role) => !["orchestrator", "team-browser-agent"].includes(role.agent)) ||
        new Set(core.map((role) => role.agent)).size !== core.length
      )
        throw Error("Canonical core roles are ambiguous")
      const roles = await run(deps.orchestra.roles(OrchestraSchema.ProjectID.make(projectID)))
      return [
        ...core,
        ...roles
          .filter((role) => !core.some((item) => item.agent === role.agent))
          .map((role): V2.Role => {
            const { models, tools, hub, registry, ...spec } = Schema.decodeUnknownSync(OrchestraSchema.RoleSpec)(role)
            return {
              ...spec,
              agent: role.agent,
              ...(models === undefined ? {} : { models: [...models] }),
              ...(tools === undefined ? {} : { tools: [...tools] }),
              ...(hub === undefined ? {} : { hub: [...hub] }),
              ...(registry === undefined ? {} : { registry: [...registry] }),
            }
          }),
      ]
    },
    playbook: async (id) => {
      if (id !== projectID) throw Error("Process owner differs")
      const state = await process()
      const live = await run(deps.orchestra.playbook(OrchestraSchema.ProjectID.make(id)))
      if (!state) return { text: live?.text ?? null, recommendedRoles: [] }
      if ((live?.text ?? null) !== state.playbook) throw Error("Project playbook differs from its owner snapshot")
      return { text: state.playbook, recommendedRoles: state.recommendedRoles }
    },
    programs: async (id) => {
      if (id !== projectID) throw Error("Process owner differs")
      return (await process())?.programs ?? []
    },
    skills: async (input) => {
      if (input.projectID !== projectID) throw Error("Process owner differs")
      await process()
      const raw = await run(deps.kv.get(ProcessSkills.PREFIX + projectID))
      const registry = ProcessSkills.parse(raw, projectID)
      const state = await process()
      if (raw === undefined && !state) return { definitions: [], assignments: [] }
      if (!registry) throw Error("Project skill assignments are missing or invalid")
      const definitions = await run(
        Definitions.load(deps.kv, { projectID, registry, allowed: new Set(registry.skills.map((skill) => skill.id)) }),
      )
      if (!definitions || definitions.length !== registry.skills.length)
        throw Error("Project skill definitions are incomplete")
      if (!state) throw Error("Assigned project skills require their owning process snapshot")
      const marker = await run(deps.kv.get("orchestra/project-import/" + projectID))
      const receipt =
        typeof marker === "string" ? await run(deps.kv.get("orchestra/template-import/" + marker)) : undefined
      if (
        !receipt ||
        typeof receipt !== "object" ||
        Array.isArray(receipt) ||
        !("plan" in receipt) ||
        !receipt.plan ||
        typeof receipt.plan !== "object" ||
        Array.isArray(receipt.plan) ||
        !("sessions" in receipt.plan) ||
        !Array.isArray(receipt.plan.sessions)
      )
        throw Error("Process source session mapping is missing")
      const sessionMap = new Map<string, string>()
      for (const row of receipt.plan.sessions) {
        if (
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          !("slot" in row) ||
          !("id" in row) ||
          typeof row.slot !== "string" ||
          typeof row.id !== "string" ||
          sessionMap.has(row.slot) ||
          !input.sessionIDs.includes(row.id)
        )
          throw Error("Process source session mapping is invalid")
        sessionMap.set(row.slot, row.id)
      }
      if (
        sessionMap.size !== state.source.sessions.length ||
        state.source.sessions.some((row) => !sessionMap.has(row.slot))
      )
        throw Error("Process source session mapping is incomplete")
      const roleMap = new Map(
        state.source.process.roles.map((role, index) => [
          role.agent,
          ["orchestrator", "team-browser-agent"].includes(role.agent)
            ? role.agent
            : "team-" + ProcessSkills.namespace(projectID) + (index + 1),
        ]),
      )
      const skillMap = new Map(
        state.source.process.skills.map((skill, index) => [skill.id, ProcessSkills.namespace(projectID) + (index + 1)]),
      )
      const assignments: Source.ProcessSource["skillAssignments"] = state.source.process.skillAssignments.map(
        (row) => ({
          target:
            row.target.kind === "session"
              ? { kind: "session", sessionID: sessionMap.get(row.target.session)! }
              : row.target.kind === "role"
                ? { kind: "role", role: roleMap.get(row.target.role)! }
                : row.target,
          skills: row.skills.map((id) => skillMap.get(id)!),
        }),
      )
      const expected: ProcessSkills.Registry = {
        version: 1,
        projectID,
        skills: state.source.process.skills.map((skill) => ({
          id: skillMap.get(skill.id)!,
          dependencies: skill.dependencies.map((id) => skillMap.get(id)!),
          targets: assignments.filter((row) => row.skills.includes(skillMap.get(skill.id)!)).map((row) => row.target),
        })),
      }
      if (!isDeepStrictEqual(expected, registry)) throw Error("Process assignments differ from their source snapshot")
      const expectedSkills = state.source.process.skills.map((skill) => ({
        ...skill,
        id: skillMap.get(skill.id)!,
        dependencies: skill.dependencies.map((id) => skillMap.get(id)!),
      }))
      if (
        !isDeepStrictEqual(
          definitions.map((row) => row.skill),
          V2.parseSkills(expectedSkills),
        )
      )
        throw Error("Process definitions differ from their source snapshot")
      return {
        definitions: definitions.map(({ skill, root }) => ({
          id: skill.id,
          name: skill.name,
          ...(skill.description === undefined ? {} : { description: skill.description }),
          ...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }),
          root,
          entry: skill.entry,
          files: skill.files.map((file) => file.path),
          dependencies: skill.dependencies,
        })),
        assignments,
      }
    },
  }
}
