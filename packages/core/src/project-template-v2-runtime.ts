export * as ProjectTemplateV2Runtime from "./project-template-v2-runtime.js"

import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import { Orchestra } from "@orchestra/schema/orchestra"
import { Mode } from "@orchestra/schema/mode"
import { Model } from "@orchestra/schema/model"
import type { KV } from "./kv.js"
import type { ProjectTemplateMaterialize as Materialize } from "./project-template-materialize.js"
import { ProjectTemplate as V1 } from "./project-template.js"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"
import { ProjectTemplateV2Plan as Plan } from "./project-template-v2-plan.js"
import { ProcessSkills } from "./process-skills.js"
import { ProcessSkillDefinitions as Definitions } from "./process-skill-definitions.js"
import { ProcessSkillFileReceipt as Files } from "./process-skill-file-receipt.js"

export const PROJECT_PROCESS = "orchestra/project-process/"
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
/** Passive project snapshot, validated against the closed source and deterministic local role remap. */
export const read = Effect.fn("ProjectTemplateV2Runtime.read")(function* (kv: KV.Interface, projectID: string) {
  const value = yield* kv.get(PROJECT_PROCESS + projectID)
  if (value === undefined) return undefined
  if (
    !record(value) ||
    Object.keys(value).length !== 7 ||
    value.version !== 2 ||
    value.projectID !== projectID ||
    typeof value.source !== "string" ||
    typeof value.digest !== "string"
  )
    return undefined
  const parsed = V2.preview(value.source)
  if (!parsed.ok || parsed.value.digest !== value.digest) return undefined
  const process = parsed.value.bundle.process
  const map = new Map(
    process.roles.map((role, i) => [
      role.agent,
      ["orchestrator", "team-browser-agent"].includes(role.agent)
        ? role.agent
        : "team-" + ProcessSkills.namespace(projectID) + (i + 1),
    ]),
  )
  if (
    !isDeepStrictEqual(value.playbook, process.playbook) ||
    !isDeepStrictEqual(value.programs, process.programs) ||
    !isDeepStrictEqual(
      value.recommendedRoles,
      process.recommendedRoles.map((role) => map.get(role)),
    )
  )
    return undefined
  return {
    source: parsed.value.bundle,
    playbook: process.playbook,
    recommendedRoles: process.recommendedRoles.map((role) => map.get(role)!),
    programs: process.programs,
  }
})
export interface Dependencies {
  kv: KV.Interface
  dataDirectory: string
  installedVersion: string
  /** Live global definitions only. Project-local imports are deliberately not collision candidates on resume. */
  destination: () => Promise<Omit<Plan.Destination, "projectID" | "installedVersion" | "reviewedDigest">>
  changed: () => Promise<void>
}
export function make(deps: Dependencies): Materialize.ProcessAdapter {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const serial = (value: unknown): KV.Value => JSON.parse(JSON.stringify(value))
  const derive = async (text: string, digest: string, projectID: string) => {
    const parsed = V2.preview(text)
    if (!parsed.ok || parsed.value.digest !== digest) throw Error("Process template differs from the reviewed source")
    const plan = Plan.prepare(text, {
      ...(await deps.destination()),
      projectID,
      installedVersion: deps.installedVersion,
      reviewedDigest: digest,
    })
    if (plan.requirements.coreRoleDifferences.length || plan.requirements.missingModels.length)
      throw Error("Process core roles or models differ from the reviewed destination")
    for (const row of plan.roles) {
      const role = row.definition
      Schema.decodeUnknownSync(Orchestra.RoleSpec)(role)
      if (role.mode && !Mode.of(role.mode)) throw Error("Process role requires an unsupported work mode")
      for (const value of [...(role.model ? [role.model] : []), ...(role.models ?? [])]) Model.Ref.parse(value)
    }
    const { process: _, ...base } = parsed.value.bundle
    const projection = V1.preview(
      JSON.stringify({ ...base, version: 1, sessions: plan.remapped.sessions, rules: plan.remapped.rules }),
    )
    if (!projection.ok) throw Error("Process base configuration cannot be represented unchanged")
    return { plan, source: parsed.value, template: projection.value.text }
  }
  const fromReceipt = async (receipt: Materialize.Receipt) => {
    if (!receipt.process || Object.keys(receipt.process).length !== 3 || receipt.process.version !== 2)
      throw Error("Exact process source receipt required")
    const value = await derive(receipt.process.template, receipt.process.digest, receipt.projectID)
    if (value.template !== receipt.template) throw Error("Process base configuration changed after review")
    return value
  }
  const processState = (r: Materialize.Receipt, value: Awaited<ReturnType<typeof fromReceipt>>) => ({
    version: 2,
    projectID: r.projectID,
    source: value.source.text,
    digest: value.source.digest,
    playbook: value.source.bundle.process.playbook,
    recommendedRoles: value.plan.remapped.recommendedRoles,
    programs: value.source.bundle.process.programs,
  })
  const registry = (r: Materialize.Receipt, value: Awaited<ReturnType<typeof fromReceipt>>): ProcessSkills.Registry => {
    const sessions = new Map(r.plan.sessions.map((session) => [session.slot, session.id]))
    return {
      version: 1,
      projectID: r.projectID,
      skills: value.plan.remapped.skillDependencies.map((skill) => ({
        ...skill,
        targets: value.plan.remapped.skillAssignments
          .filter((assignment) => assignment.skills.includes(skill.id))
          .map((assignment) => {
            if (assignment.target.kind !== "session") return assignment.target
            const sessionID = sessions.get(assignment.target.session)
            if (!sessionID) throw Error("Process assignment has no reserved session")
            return { kind: "session" as const, sessionID }
          }),
      })),
    }
  }
  const skillDefinitions = (value: Awaited<ReturnType<typeof fromReceipt>>) =>
    value.plan.skills.map((skill) => ({
      ...skill.definition,
      id: skill.target,
      dependencies: value.plan.remapped.skillDependencies.find((item) => item.id === skill.target)!.dependencies,
    }))
  const localRoles = (r: Materialize.Receipt, value: Awaited<ReturnType<typeof fromReceipt>>) =>
    value.plan.roles
      .filter((role) => role.action === "install-project-local")
      .map((role) => {
        const { agent: _, ...definition } = role.definition
        return {
          key: "orchestra/project-role/" + r.projectID + "/" + role.target.replace(/^team-/, ""),
          value: serial({ ...definition, created: r.createdAt }),
        }
      })
  const exact = async (key: string, expected: KV.Value, write: boolean) => {
    if (write) {
      await run(
        deps.kv.atomicUpdate(key, (current) => {
          if (current !== undefined && !isDeepStrictEqual(current, expected))
            throw Error("Process import refuses changed or foreign state")
          return expected
        }),
      )
    } else if (!isDeepStrictEqual(await run(deps.kv.get(key)), expected))
      throw Error("Process state changed after installation")
  }
  return {
    prepare: async (text, digest, projectID) => {
      const value = await derive(text, digest, projectID)
      return {
        template: value.template,
        process: { version: 2, template: value.source.text, digest },
        roles: new Set(value.plan.roles.map((role) => role.target)),
      }
    },
    validate: async (r) => new Set((await fromReceipt(r)).plan.roles.map((role) => role.target)),
    metadata: (r, session) => {
      if (!r.process) throw Error("Process metadata has no source")
      const parsed = V2.preview(r.process.template)
      if (!parsed.ok || parsed.value.digest !== r.process.digest) throw Error("Process metadata source changed")
      const row = parsed.value.bundle.process.sessionModels.find((item) => item.session === session.slot)
      if (!row) throw Error("Process fallback model snapshot is missing")
      return {
        [Orchestra.SessionModelsMetadataKey]: row.models.map((model) => ({
          providerID: model.provider,
          id: model.id,
          ...(model.variant === null ? {} : { variant: model.variant }),
        })),
      }
    },
    ensure: async (r) => {
      const value = await fromReceipt(r),
        assignments = registry(r, value),
        definitions = skillDefinitions(value)
      for (const role of localRoles(r, value)) await exact(role.key, role.value, true)
      await exact(ProcessSkills.PREFIX + r.projectID, serial(assignments), true)
      const owner = { id: r.id, sourceDigest: r.process!.digest }
      const files = Files.preview(deps.dataDirectory, assignments, definitions, owner)
      await run(Files.install(deps.kv, deps.dataDirectory, assignments, definitions, owner, files.digest))
      await exact(PROJECT_PROCESS + r.projectID, serial(processState(r, value)), true)
    },
    verify: async (r) => {
      const value = await fromReceipt(r),
        assignments = registry(r, value)
      for (const role of localRoles(r, value)) await exact(role.key, role.value, false)
      await exact(ProcessSkills.PREFIX + r.projectID, serial(assignments), false)
      await exact(PROJECT_PROCESS + r.projectID, serial(processState(r, value)), false)
      const owner = { id: r.id, sourceDigest: r.process!.digest }
      const filePlan = Files.preview(deps.dataDirectory, assignments, skillDefinitions(value), owner)
      await Files.verify(deps.dataDirectory, assignments, skillDefinitions(value), owner, filePlan.digest)
      const expected = Definitions.preview(assignments, filePlan.definitions)
      await exact(Definitions.PREFIX + r.projectID, serial(expected.snapshot), false)
      const definitions = await run(
        Definitions.load(deps.kv, {
          projectID: r.projectID,
          registry: assignments,
          allowed: new Set(assignments.skills.map((skill) => skill.id)),
        }),
      )
      if (!definitions || definitions.length !== assignments.skills.length)
        throw Error("Process definition files changed before publication")
    },
    changed: deps.changed,
  }
}
