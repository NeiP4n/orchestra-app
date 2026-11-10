export * as Skill from "./skill.js"

import { makeLocationNode } from "@orchestra/util/effect/app-node"
import type { FSUtil } from "@orchestra/util/fs-util"
import path from "path"
import { Context, Effect, Layer, Types } from "effect"
import { Skill } from "@orchestra/schema/skill"
import { Bus } from "./bus.js"
import { Permission } from "./permission.js"
import { State } from "./state.js"
import { KV } from "./kv.js"
import { AbsolutePath } from "./schema.js"
import { ProcessSkillDefinitions } from "./process-skill-definitions.js"
import { ProcessSkills } from "./process-skills.js"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = Skill.Source

export const Info = Skill.Info
export type Info = Skill.Info & { readonly processFiles?: readonly string[] }
export const ID = Skill.ID
export type ID = Skill.ID
export const Name = Skill.Name
export type Name = Skill.Name

export { Event } from "@orchestra/schema/skill"

export const available = (skills: ReadonlyArray<Info>, permissions: Permission.Ruleset) =>
  skills.filter((skill) => Permission.evaluate("skill", skill.id, permissions).effect !== "deny")

export const toModelOutput = (skill: Info, files: ReadonlyArray<string>) => {
  const directory = path.dirname(skill.path)
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Base directory for this skill: ${directory}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

export const prepare = Effect.fn("Skill.prepare")(function* (fs: FSUtil.Interface, skill: Info) {
  const directory = path.dirname(skill.path)
  if (ProcessSkills.reserved(skill.id) && path.basename(skill.path) === "SKILL.md" && !skill.processFiles)
    return yield* Effect.die(new Error("Project skill file inventory is not installed"))
  const files =
    skill.processFiles ??
    (path.basename(skill.path) === "SKILL.md"
      ? (yield* fs.scan("**/*", { cwd: directory, absolute: true, include: "file", dot: true }))
          .filter((file) => path.basename(file) !== "SKILL.md")
          .toSorted()
          .slice(0, 10)
      : [])
  return {
    directory,
    output: toModelOutput(skill, files),
  }
})

export type Data = {
  skills: Map<ID, Types.DeepMutable<Info>>
}

export type Editor = {
  list: () => readonly Types.DeepMutable<Info>[]
  get: (id: string) => Types.DeepMutable<Info> | undefined
  add: (skill: Info) => void
  update: (id: string, update: (skill: Types.DeepMutable<Info>) => void) => void
  remove: (id: string) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly get: (id: ID, context?: ProcessSkills.Context) => Effect.Effect<Info | undefined>
  readonly list: (context?: ProcessSkills.Context) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const kv = yield* KV.Service

    let processEntries = new Map<ID, Info>()
    const state = State.create<Data, Editor>({
      name: "skill",
      initial: () => ({
        skills: new Map(Array.from(processEntries, ([id, skill]) => [id, { ...skill } as Types.DeepMutable<Info>])),
      }),
      editor: (editor) => ({
        list: () => Array.from(editor.skills.values()),
        get: (id) => editor.skills.get(ID.make(id)),
        add: (skill) => {
          editor.skills.set(skill.id, { ...skill } as Types.DeepMutable<Info>)
        },
        update: (id, update) => {
          const current = editor.skills.get(ID.make(id))
          if (!current) return
          update(current)
          current.id = ID.make(id)
        },
        remove: (id) => {
          editor.skills.delete(ID.make(id))
        },
      }),
      notify: () => bus.publish(Skill.Event.Updated, {}).pipe(Effect.asVoid),
    })

    const resolveProcess = Effect.fn("Skill.resolveProcess")(function* (context?: ProcessSkills.Context) {
      const selected = yield* ProcessSkills.selection(kv, context)
      const definitions = selected ? yield* ProcessSkillDefinitions.load(kv, selected) : []
      const next = new Map<ID, Info>(
        (definitions ?? []).map(({ skill, root }) => [
          ID.make(skill.id),
          {
            id: ID.make(skill.id),
            name: Name.make(skill.name),
            description: skill.description,
            autoinvoke: skill.autoinvoke,
            path: AbsolutePath.make(path.join(root, skill.entry)),
            content: skill.files.find((file) => file.path === skill.entry)!.content,
            processFiles: skill.files
              .filter((file) => file.path !== skill.entry)
              .map((file) => path.join(root, file.path)),
          },
        ]),
      )
      if (JSON.stringify(Array.from(next)) !== JSON.stringify(Array.from(processEntries))) {
        processEntries = next
        state.invalidate()
      }
      return definitions === undefined ? new Set<string>() : (selected?.allowed ?? new Set<string>())
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("Skill.get")(function* (id, context) {
        if (ProcessSkills.reserved(id) && !(yield* resolveProcess(context)).has(id)) return undefined
        return state.get().skills.get(id)
      }),
      list: Effect.fn("Skill.list")(function* (context) {
        const allowed = yield* resolveProcess(context)
        return Array.from(state.get().skills.values()).filter(
          (skill) => !ProcessSkills.reserved(skill.id) || allowed.has(skill.id),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, KV.node],
})
