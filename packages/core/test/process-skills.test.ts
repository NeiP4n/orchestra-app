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

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Skill.node, SkillInstructions.node, KV.node])))
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
      expect((yield* skills.list()).map((s) => s.id)).toEqual(["global"])
      expect(yield* skills.get(ids[0])).toBeUndefined()
      expect((yield* skills.list(context)).map((s) => s.id)).toEqual(["global", ...ids])
      expect(yield* skills.get(ids[1], context)).toEqual(info(ids[1]))
      expect((yield* skills.list({ sessionID, agent: "review" })).map((s) => s.id)).toEqual(["global", ids[2], ids[3]])
      expect((yield* skills.list({ sessionID: "ses_process_main", agent: "review" })).map((s) => s.id)).toEqual([
        "global",
        ids[3],
      ])
      expect((yield* skills.list({ sessionID: "ses_other_main", agent: "build" })).map((s) => s.id)).toEqual(["global"])
      expect((yield* skills.list({ sessionID: "ses_unclaimed", agent: "build" })).map((s) => s.id)).toEqual(["global"])
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
