import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ProjectTemplateV2Source as S } from "../src/project-template-v2-source"
import { ProjectTemplateSource as V1 } from "../src/project-template-source"
import { processFixture } from "./project-template-v2.test"
const fixture = () => {
  const source: V1.Source = {
    project: { id: "prj_source", name: "Factory", main: "ses_source" },
    sessions: [{ id: "ses_source", title: "Main", agent: "orchestrator", model: { providerID: "demo", modelID: "free" } }],
    ownedSessionIDs: new Set(["ses_source"]), browsers: [], rules: [], schedules: [], vault: [], selectedGlobalSlotIDs: new Set(), providers: [], mcp: [],
  }
  const p = processFixture().process
  const process: S.ProcessSource = { ...p, skillAssignments: [
    { target: { kind: "project" }, skills: ["marketplace"] }, { target: { kind: "session", sessionID: "ses_source" }, skills: [] },
  ], sessionModels: [{ sessionID: "ses_source", models: p.sessionModels[0].models }] }
  return { source, process }
}
const metadata = { name: "Process", description: "Reusable process", minOrchestraVersion: "1.0.0" }
test("capture keeps recommended unopened roles, dependency closure, empty assignments and ordered fallback snapshots", () => {
  const { source, process } = fixture(), unused = structuredClone(process.skills[0]); unused.id = "unrelated"
  const dependency = structuredClone(process.skills[0]); dependency.id = "helper"
  process.skills = [...process.skills, unused, dependency]
  process.skills[0].dependencies = ["helper"]
  const result = S.capture(source, metadata, process)
  if (!result.ok) throw Error(result.error)
  expect(result.value.bundle.sessions[0].slot).toBe("session_1")
  expect(result.value.bundle.process.roles).toEqual([...process.roles])
  expect(result.value.bundle.process.skills.map((s) => s.id)).toEqual(["marketplace", "helper"])
  expect(result.value.bundle.process.skillAssignments[1]).toEqual({ target: { kind: "session", session: "session_1" }, skills: [] })
  expect(result.value.bundle.process.sessionModels).toEqual([{ session: "session_1", models: process.sessionModels[0].models }])
  expect(JSON.stringify(result)).not.toContain("ses_source")
})
for (const [name, change] of [
  ["missing used role", (p: S.ProcessSource) => p.roles = p.roles.slice(0, 1)],
  ["missing model snapshot", (p: S.ProcessSource) => p.sessionModels = []],
  ["foreign model snapshot", (p: S.ProcessSource) => p.sessionModels[0].sessionID = "ses_foreign"],
  ["foreign skill assignment", (p: S.ProcessSource) => p.skillAssignments.push({ target: { kind: "session", sessionID: "ses_foreign" }, skills: [] })],
  ["missing skill", (p: S.ProcessSource) => p.skills = []],
  ["missing dependency", (p: S.ProcessSource) => p.skills[0].dependencies = ["absent"]],
] as const) test(`capture fails instead of dropping ${name}`, () => {
  const { source, process } = fixture(); change(process)
  expect(S.capture(source, metadata, process).ok).toBe(false)
})
test("bounded skill file reader captures exact selected definitions, not neighboring data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-source-"))
  try {
    await mkdir(path.join(root, "references")); await writeFile(path.join(root, "SKILL.md"), "# A skill\n")
    await writeFile(path.join(root, "references", "guide.md"), "Exact text.\n")
    await writeFile(path.join(root, "unrelated-data.txt"), "PRIVATE_CANARY")
    const files = await S.readSkillFiles(root, ["SKILL.md", "references/guide.md"])
    expect(files.map((f) => [f.path, f.content])).toEqual([["SKILL.md", "# A skill\n"], ["references/guide.md", "Exact text.\n"]])
    expect(JSON.stringify(files)).not.toContain("PRIVATE_CANARY")
    await symlink(path.join(root, "references"), path.join(root, "alias"))
    await expect(S.readSkillFiles(root, ["alias/guide.md"])).rejects.toThrow("cannot be captured safely")
    await link(path.join(root, "SKILL.md"), path.join(root, "hard.md"))
    await expect(S.readSkillFiles(root, ["hard.md"])).rejects.toThrow("cannot be captured safely")
    for (const name of ["../outside.md", ".env", "credentials.json", "references/../SKILL.md", "CON.md", "folder./guide.md"]) await expect(S.readSkillFiles(root, [name])).rejects.toThrow("cannot be captured safely")
    await writeFile(path.join(root, "binary.md"), Buffer.from([0xff, 0xfe]))
    await expect(S.readSkillFiles(root, ["binary.md"])).rejects.toThrow("cannot be captured safely")
  } finally { await rm(root, { recursive: true, force: true }) }
})
