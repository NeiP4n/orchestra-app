import { lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ProcessSkillFiles as Files } from "@orchestra/core/process-skill-files"
import { ProcessSkills } from "@orchestra/core/process-skills"
import { ProcessSkillDefinitions as Definitions } from "@orchestra/core/process-skill-definitions"
import { ProjectTemplateV2 as V2 } from "@orchestra/core/project-template-v2"
import { Skill } from "@orchestra/core/skill"
import { KV } from "@orchestra/core/kv"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const projectID = "prj_skill_files"
const id = ProcessSkills.namespace(projectID) + "1"
const registry: ProcessSkills.Registry = {
  version: 1,
  projectID,
  skills: [{ id, dependencies: [], targets: [{ kind: "project" }] }],
}
const skills: V2.Skill[] = [
  {
    id,
    name: "Reviewed process",
    entry: "SKILL.md",
    dependencies: [],
    files: [
      {
        path: "SKILL.md",
        content: "# Reviewed process\r\nRead references/check.md and scripts/check.ts.\n",
        sha256: "",
      },
      { path: "references/check.md", content: "Wait for approval.\n", sha256: "" },
      { path: "scripts/check.ts", content: "export const check = () => true\n", sha256: "" },
    ].map((file) => ({ ...file, sha256: V2.hash(file.content) })),
  },
]
async function temporary(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "process-skill-files-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("materializes only reviewed exact text with private non-executable file modes and refuses overwrite", () =>
  temporary(async (root) => {
    const plan = Files.preview(root, registry, skills)
    await expect(Files.materialize(root, registry, skills, "wrong")).rejects.toThrow("changed after review")
    expect(await readdir(root)).toEqual([])
    const result = await Files.materialize(root, registry, skills, plan.digest)
    expect(result).toEqual(plan)
    for (const file of skills[0].files) {
      const target = path.join(result.definitions[0].root, file.path)
      expect(await readFile(target, "utf8")).toBe(file.content)
      expect((await lstat(target)).mode & 0o777).toBe(0o600)
    }
    expect((await lstat(result.directory)).mode & 0o777).toBe(0o700)
    await expect(Files.materialize(root, registry, skills, plan.digest)).rejects.toThrow()
    expect(await readFile(path.join(result.definitions[0].root, "SKILL.md"), "utf8")).toBe(skills[0].files[0].content)
  }))

test("review binds root, project, files and assignments before any destination write", () =>
  temporary(async (root) => {
    const plan = Files.preview(root, registry, skills)
    const changed = structuredClone(skills)
    changed[0].files[0].content = "Changed process"
    changed[0].files[0].sha256 = V2.hash(changed[0].files[0].content)
    await expect(Files.materialize(root, registry, changed, plan.digest)).rejects.toThrow()
    const assignments = structuredClone(registry)
    assignments.skills[0].targets = []
    await expect(Files.materialize(root, assignments, skills, plan.digest)).rejects.toThrow()
    const invalid = structuredClone(skills)
    invalid[0].files[0].path = "../outside.md"
    expect(() => Files.preview(root, registry, invalid)).toThrow()
    await mkdir(path.join(root, "other"))
    await expect(Files.materialize(path.join(root, "other"), registry, skills, plan.digest)).rejects.toThrow()
    expect(await readdir(root)).toEqual(["other"])
  }))

test("refuses linked parents and pre-existing destinations without touching their contents", () =>
  temporary(async (root) => {
    const data = path.join(root, "data"),
      outside = path.join(root, "outside")
    await mkdir(data)
    await mkdir(outside)
    await writeFile(path.join(outside, "keep.txt"), "Keep")
    await symlink(outside, path.join(data, "process-skills"), "dir")
    const plan = Files.preview(data, registry, skills)
    await expect(Files.materialize(data, registry, skills, plan.digest)).rejects.toThrow("links")
    expect(await readdir(outside)).toEqual(["keep.txt"])
    await rm(path.join(data, "process-skills"))
    await mkdir(path.join(data, "process-skills"))
    await mkdir(plan.directory)
    await writeFile(path.join(plan.directory, "keep.txt"), "Keep destination")
    await expect(Files.materialize(data, registry, skills, plan.digest)).rejects.toThrow()
    expect(await readFile(path.join(plan.directory, "keep.txt"), "utf8")).toBe("Keep destination")
  }))

test("concurrent materialization has one create-only winner", () =>
  temporary(async (root) => {
    const plan = Files.preview(root, registry, skills)
    const results = await Promise.allSettled([
      Files.materialize(root, registry, skills, plan.digest),
      Files.materialize(root, registry, skills, plan.digest),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(await readFile(path.join(plan.definitions[0].root, "SKILL.md"), "utf8")).toBe(skills[0].files[0].content)
  }))

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Skill.node, KV.node])))
it.live(
  "installs files and definitions while unpublished, then exposes them only when the owning receipt is published",
  () =>
    Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "process-skill-install-"))),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ).pipe(
      Effect.flatMap((root) =>
        Effect.gen(function* () {
          const kv = yield* KV.Service
          const catalog = yield* Skill.Service
          const sessionID = "ses_skill_files"
          yield* kv.set("orchestra/project/" + projectID, {
            id: projectID,
            name: "Imported",
            directory: root,
            main: sessionID,
            created: 1,
          })
          yield* kv.set("orchestra/project-import/" + projectID, "receipt")
          yield* kv.set("orchestra/template-import/receipt", { projectID, phase: "prepared" })
          yield* ProcessSkills.install(kv, registry)
          const plan = Files.preview(root, registry, skills)
          const installed = yield* Files.install(kv, root, registry, skills, plan.digest)
          expect(installed.digest).toBe(plan.digest)
          expect(yield* kv.get(Definitions.PREFIX + projectID)).toBeDefined()
          const context = { sessionID, agent: "build" }
          expect(yield* catalog.get(Skill.ID.make(id), context)).toBeUndefined()
          yield* kv.set("orchestra/template-import/receipt", { projectID, phase: "published" })
          const loaded = yield* catalog.get(Skill.ID.make(id), context)
          expect(loaded?.content).toBe(skills[0].files[0].content)
          expect(loaded?.processFiles).toEqual(
            skills[0].files.slice(1).map((file) => path.join(installed.definitions[0].root, file.path)),
          )
          expect(yield* catalog.get(Skill.ID.make(id), { sessionID: "ses_foreign", agent: "build" })).toBeUndefined()
          expect((yield* Files.install(kv, root, registry, skills, plan.digest).pipe(Effect.exit))._tag).toBe("Failure")
        }),
      ),
    ),
)
