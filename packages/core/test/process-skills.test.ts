import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "@orchestra/core/config"
import { ManagedPolicy } from "@orchestra/core/managed-policy"
import { ProcessSkillDefinitions } from "@orchestra/core/process-skill-definitions"
import { ProjectTemplateV2 as V2 } from "@orchestra/core/project-template-v2"
import { FSUtil } from "@orchestra/util/fs-util"
import { registerIntegrationPolicy } from "./fixture/policy"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { KV } from "@orchestra/core/kv"
import { Skill } from "@orchestra/core/skill"
import { SkillInstructions } from "@orchestra/core/skill/instructions"
import { ProcessSkills } from "@orchestra/core/process-skills"
import { AbsolutePath } from "@orchestra/core/schema"
import { testEffect } from "./lib/effect"
import { readInitial } from "./lib/instructions"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Skill.node, SkillInstructions.node, KV.node, Config.node, ManagedPolicy.node, FSUtil.node]),
    [Config.node.replace(Config.testLayer())],
  ),
)
const projectID = "prj_process_skills"
const otherID = "prj_other_process"
const prefix = ProcessSkills.namespace(projectID)
const ids = [1, 2, 3, 4].map((n) => Skill.ID.make(prefix + n))
const sessionID = "ses_process_owner"
const context = { sessionID, agent: "build" }
const info = (id: string) =>
  Skill.Info.make({
    id: Skill.ID.make(id),
    name: Skill.Name.make(id),
    description: "Local guidance",
    path: AbsolutePath.make(`/process/${id}/entry.md`),
    content: `# ${id}`,
  })
const project = (id: string, main: string) => ({ id, main, name: "Process", directory: "/shared", created: 1 })
const registry: ProcessSkills.Registry = {
  version: 1,
  projectID,
  skills: [
    { id: ids[0], dependencies: [ids[1]], targets: [{ kind: "role", role: "build" }] },
    { id: ids[1], dependencies: [], targets: [] },
    { id: ids[2], dependencies: [], targets: [{ kind: "session", sessionID }] },
    { id: ids[3], dependencies: [], targets: [{ kind: "project" }] },
  ],
}

// Real KV and location-scoped catalog, not a mock of the authorization decision.
describe("Process skill assignments", () => {
  it.live("reloads reviewed definitions from KV, applies policy and never scans unlisted files", () =>
    Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "process-definitions-"))),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ).pipe(
      Effect.flatMap((root) =>
        Effect.gen(function* () {
          const kv = yield* KV.Service
          const skills = yield* Skill.Service
          const managed = yield* ManagedPolicy.Service
          const fs = yield* FSUtil.Service
          yield* kv.set("orchestra/project/" + projectID, project(projectID, sessionID))
          const assignments: ProcessSkills.Registry = {
            version: 1,
            projectID,
            skills: [{ id: ids[0], dependencies: [], targets: [{ kind: "project" }] }],
          }
          yield* ProcessSkills.install(kv, assignments)
          const files = [
            { path: "SKILL.md", content: "# Project process\nRead guide.md.\n", sha256: "" },
            { path: "guide.md", content: "Wait for approval.\n", sha256: "" },
          ].map((file) => ({ ...file, sha256: V2.hash(file.content) }))
          const definitions = [
            {
              root,
              skill: {
                id: ids[0],
                name: "Project process",
                description: "Review work",
                entry: "SKILL.md",
                files,
                dependencies: [],
              },
            },
          ]
          yield* Effect.promise(async () => {
            for (const file of files) await writeFile(path.join(root, file.path), file.content)
            await writeFile(path.join(root, "unrelated-private.txt"), "Not part of this process")
          })
          const reviewed = ProcessSkillDefinitions.preview(assignments, definitions)
          expect(
            (yield* ProcessSkillDefinitions.install(kv, assignments, definitions, "wrong").pipe(Effect.exit))._tag,
          ).toBe("Failure")
          expect(yield* kv.get(ProcessSkillDefinitions.PREFIX + projectID)).toBeUndefined()
          yield* ProcessSkillDefinitions.install(kv, assignments, definitions, reviewed.digest)
          expect(
            (yield* ProcessSkillDefinitions.install(kv, assignments, definitions, reviewed.digest).pipe(Effect.exit))
              ._tag,
          ).toBe("Failure")
          expect(yield* skills.get(ids[0])).toBeUndefined()
          // No editor registration supplies this definition. The real service must hydrate it from KV.
          const loaded = yield* skills.get(ids[0], context)
          expect(loaded?.content).toBe(files[0].content)
          expect(loaded?.processFiles).toEqual([path.join(root, "guide.md")])
          const prepared = yield* Skill.prepare(fs, loaded!)
          expect(prepared.output).toContain(path.join(root, "guide.md"))
          expect(prepared.output).not.toContain("unrelated-private")
          expect(yield* skills.list()).toEqual([])
          expect((yield* skills.get(ids[0], context))?.content).toBe(files[0].content)
          yield* registerIntegrationPolicy({ skill: skills })
          yield* managed.set({
            statements: [{ action: "integration.use", resource: `skill:${ids[0]}`, effect: "deny" }],
          })
          yield* skills.reload()
          expect(yield* skills.get(ids[0], context)).toBeUndefined()
          yield* managed.set({ statements: [] })
          yield* skills.reload()
          expect((yield* skills.list(context)).map((skill) => skill.id)).toEqual([ids[0]])
          yield* skills.transform((editor) => editor.add(info(ids[0])))
          yield* kv.set(ProcessSkillDefinitions.PREFIX + projectID, JSON.parse(JSON.stringify({ ...reviewed.snapshot, registryDigest: "corrupt" })))
          expect(yield* skills.get(ids[0], context)).toBeUndefined()
          yield* kv.set(ProcessSkillDefinitions.PREFIX + projectID, JSON.parse(JSON.stringify(reviewed.snapshot)))
          yield* Effect.promise(() => writeFile(path.join(root, "guide.md"), "Changed after review"))
          expect(yield* skills.get(ids[0], context)).toBeUndefined()
        }),
      ),
    ),
  )

  it.live("scopes catalog, dependency closure and guidance to explicit project ownership", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const skills = yield* Skill.Service
      const instructions = yield* SkillInstructions.Service
      yield* kv.set("orchestra/project/" + projectID, project(projectID, "ses_process_main"))
      yield* kv.set("orchestra/project/" + otherID, project(otherID, "ses_other_main"))
      yield* kv.set("orchestra/owner/" + sessionID, projectID)
      yield* ProcessSkills.install(kv, registry)
      yield* skills.transform((editor) => {
        editor.add(info("global"))
        ids.forEach((id) => editor.add(info(id)))
      })
      expect((yield* skills.list()).map((s) => s.id)).toEqual([Skill.ID.make("global")])
      expect(yield* skills.get(ids[0])).toBeUndefined()
      expect((yield* skills.list(context)).map((s) => s.id)).toEqual([Skill.ID.make("global"), ...ids])
      expect(yield* skills.get(ids[1], context)).toEqual(info(ids[1]))
      expect((yield* skills.list({ sessionID, agent: "review" })).map((s) => s.id)).toEqual([Skill.ID.make("global"), ids[2], ids[3]])
      expect((yield* skills.list({ sessionID: "ses_process_main", agent: "review" })).map((s) => s.id)).toEqual([
        Skill.ID.make("global"),
        ids[3],
      ])
      expect((yield* skills.list({ sessionID: "ses_other_main", agent: "build" })).map((s) => s.id)).toEqual([Skill.ID.make("global")])
      expect((yield* skills.list({ sessionID: "ses_unclaimed", agent: "build" })).map((s) => s.id)).toEqual([Skill.ID.make("global")])
      const guidance = yield* instructions.load([], context).pipe(Effect.flatMap(readInitial))
      expect(guidance.text).toContain(ids[0])
      const denied = yield* instructions
        .load([{ action: "skill", resource: "*", effect: "deny" }], context)
        .pipe(Effect.flatMap(readInitial))
      expect(denied.text).not.toContain(ids[0])
      yield* kv.set("orchestra/owner/" + sessionID, otherID)
      expect(yield* skills.get(ids[0], context)).toBeUndefined()
      yield* kv.set("orchestra/owner/ses_process_main", "prj_missing")
      expect(yield* skills.get(ids[3], { sessionID: "ses_process_main", agent: "build" })).toBeUndefined()
      yield* kv.set("orchestra/owner/" + sessionID, projectID)
      yield* kv.remove("orchestra/project/" + projectID)
      expect(yield* skills.get(ids[3], context)).toBeUndefined()
    }),
  )

  it.live("refuses overwrite, malformed closure and unpublished or mismatched imports", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const skills = yield* Skill.Service
      yield* kv.set("orchestra/project/" + projectID, project(projectID, sessionID))
      yield* ProcessSkills.install(kv, registry)
      const before = yield* kv.get(ProcessSkills.PREFIX + projectID)
      expect((yield* ProcessSkills.install(kv, registry).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* kv.get(ProcessSkills.PREFIX + projectID)).toEqual(before)
      const cycle = structuredClone(registry)
      cycle.skills[1].dependencies = [ids[0]]
      expect(ProcessSkills.parse(cycle, projectID)).toBeUndefined()
      const cross = structuredClone(registry)
      cross.skills[0].dependencies = [ProcessSkills.namespace(otherID) + "1"]
      expect(ProcessSkills.parse(cross, projectID)).toBeUndefined()
      const malformed = structuredClone(registry)
      malformed.skills[0].id = prefix + "01"
      expect(ProcessSkills.parse(malformed, projectID)).toBeUndefined()
      yield* skills.transform((editor) => ids.forEach((id) => editor.add(info(id))))
      yield* kv.set("orchestra/project-import/" + projectID, "receipt")
      expect(yield* skills.list(context)).toEqual([])
      yield* kv.set("orchestra/template-import/receipt", { phase: "prepared", projectID })
      expect(yield* skills.list(context)).toEqual([])
      yield* kv.set("orchestra/template-import/receipt", { phase: "published", projectID: otherID })
      expect(yield* skills.list(context)).toEqual([])
      yield* kv.set("orchestra/template-import/receipt", { phase: "published", projectID })
      expect((yield* skills.list(context)).map((s) => s.id)).toEqual(ids)
      yield* kv.set(ProcessSkills.PREFIX + projectID, {
        version: 1,
        projectID,
        skills: [{ id: ids[0], dependencies: [], targets: [{ kind: "directory", path: "/shared" }] }],
      })
      expect(yield* skills.list(context)).toEqual([])
    }),
  )
})
