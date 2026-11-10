import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { ProjectTemplateV2 as V2 } from "../src/project-template-v2"
import { ProjectTemplate as V1 } from "../src/project-template"
import { templateFixture } from "./project-template.test"
export function processFixture(): V2.Bundle {
  const source = templateFixture()
  source.sessions[0].role = "orchestrator"
  const content = "# Marketplace process\nRead references/checklist.md, then scripts/inspect.ts. Publishing still needs approval.\n"
  return { ...source, version: 2, process: {
    playbook: "Review requests, prepare an offer, wait for approval before publishing.", recommendedRoles: ["team-seller"],
    roles: [
      { agent: "orchestrator", name: "Coordinator", description: "Runs the workflow", rules: "Ask before publishing.", category: "Planning", readOnly: false },
      { agent: "team-seller", name: "Seller", description: "Prepares offers", rules: "Never invent delivery promises.", category: "Sales", readOnly: true, mode: "planning", model: "demo/free#careful", models: ["demo/free#careful", "demo/backup"], variant: "careful", tools: ["read", "skill", "docs_*"], autoTools: false, hub: [], registry: ["git"] },
    ],
    skills: [{ id: "marketplace", name: "Marketplace", description: "Prepare reviewed offers", autoinvoke: false, entry: "SKILL.md", files: [
      { path: "SKILL.md", content, sha256: V2.hash(content) },
      { path: "references/checklist.md", content: "Check scope and deadline.\n", sha256: V2.hash("Check scope and deadline.\n") },
      { path: "scripts/inspect.ts", content: "export const inspect = () => true\n", sha256: V2.hash("export const inspect = () => true\n") },
    ], dependencies: [] }],
    skillAssignments: [{ target: { kind: "project" }, skills: ["marketplace"] }, { target: { kind: "role", role: "team-seller" }, skills: [] }, { target: { kind: "session", session: "main" }, skills: ["marketplace"] }],
    sessionModels: [{ session: "main", models: [{ provider: "demo", id: "free", variant: null }, { provider: "demo", id: "backup", variant: "careful" }] }],
    programs: [{ id: "git", reason: "Inspect changes before submitting." }],
  } }
}
test("v2 closed codec preserves every process field and optional absence through canonical serialization", () => {
  const original = processFixture(), first = V2.preview(JSON.stringify(original))
  if (!first.ok) throw Error(first.error)
  const second = V2.preview(first.value.text)
  expect(second).toEqual(first)
  expect(first.value.bundle).toEqual(original)
  expect(first.value.counts).toEqual({ roles: 2, skills: 1, files: 3 })
  expect(first.value.requiresReviewedInstaller).toBe(true)
  expect(first.value.startsAutomatically).toBe(false)
  expect(Object.hasOwn(first.value.bundle.process.roles[0], "tools")).toBe(false)
  expect(first.value.bundle.process.roles[1].hub).toEqual([])
})
test("version boundaries do not silently drop process definitions", () => {
  expect(V1.parse(JSON.stringify(templateFixture())).ok).toBe(true)
  expect(V1.parse(JSON.stringify(processFixture())).ok).toBe(false)
  expect(V2.parse(JSON.stringify(templateFixture())).ok).toBe(false)
  const future = { ...processFixture(), version: 3 }
  expect(V2.parse(JSON.stringify(future)).ok).toBe(false)
})
const cases: [string, (b: V2.Bundle) => void][] = [
  ["unknown process keys", b => Object.assign(b.process, { permissions: ["*"] })],
  ["unknown role keys", b => Object.assign(b.process.roles[0], { grant: true })],
  ["unknown skill keys", b => Object.assign(b.process.skills[0], { startup: "run" })],
  ["missing role", b => b.process.roles.shift()],
  ["duplicate role", b => b.process.roles.push(b.process.roles[0])],
  ["unknown recommended role", b => b.process.recommendedRoles.push("other")],
  ["unknown skill dependency", b => b.process.skills[0].dependencies.push("missing")],
  ["cycle", b => b.process.skills[0].dependencies.push("marketplace")],
  ["dangling skill assignment", b => b.process.skillAssignments[0].skills.push("missing")],
  ["dangling role assignment", b => b.process.skillAssignments[1].target = { kind: "role", role: "missing" }],
  ["dangling session assignment", b => b.process.skillAssignments[2].target = { kind: "session", session: "missing" }],
  ["duplicate assignment target", b => b.process.skillAssignments.push(b.process.skillAssignments[0])],
  ["dangling fallback session", b => b.process.sessionModels[0].session = "missing"],
  ["duplicate fallback target", b => b.process.sessionModels.push(b.process.sessionModels[0])],
  ["missing skill entry", b => b.process.skills[0].entry = "missing.md"],
  ["traversal", b => b.process.skills[0].files[0].path = "../SKILL.md"],
  ["windows traversal", b => b.process.skills[0].files[0].path = "..\\SKILL.md"],
  ["absolute path", b => b.process.skills[0].files[0].path = "/tmp/SKILL.md"],
  ["dot credentials file", b => b.process.skills[0].files[0].path = ".env"],
  ["credentials file", b => b.process.skills[0].files[0].path = "credentials.json"],
  ["case-fold collision", b => b.process.skills[0].files.push({ ...b.process.skills[0].files[0], path: "skill.md" })],
  ["hash mismatch", b => b.process.skills[0].files[0].content += "changed"],
  ["oversized content", b => { const f = b.process.skills[0].files[0]; f.content = "x".repeat(65537); f.sha256 = V2.hash(f.content) }],
  ["secret-like content", b => { const f = b.process.skills[0].files[0]; f.content = "https://example.com/?token=PRIVATE_CANARY"; f.sha256 = V2.hash(f.content) }],
]
for (const [name, mutate] of cases) test(`v2 rejects ${name} without echoing private contents`, () => {
  const b = processFixture(); mutate(b)
  const result = V2.parse(JSON.stringify(b))
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY")
})
test("v2 dependency ordering is preserved but multi-node cycles are rejected", () => {
  const b = processFixture(), extra = structuredClone(b.process.skills[0]); extra.id = "helper"; b.process.skills.push(extra)
  b.process.skills[0].dependencies = ["helper"]
  const valid = V2.parse(JSON.stringify(b)); expect(valid.ok).toBe(true)
  extra.dependencies = ["marketplace"]
  expect(V2.parse(JSON.stringify(b)).ok).toBe(false)
})

test("canonical v2 bytes and hashes survive a new disk read without using v1 save", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "process-v2-"))
  try {
    const first = V2.preview(JSON.stringify(processFixture())); if (!first.ok) throw Error(first.error)
    const file = path.join(root, "process.json")
    await writeFile(file, first.value.text, { flag: "wx", mode: 0o600 })
    const second = V2.preview(await readFile(file, "utf8"))
    expect(second).toEqual(first)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const file of ["CON", "con.md", "references/NUL.txt", "scripts/COM1.ts", "guide.", "folder./guide.md"]) test(`rejects nonportable Windows definition path ${file}`, () => {
  const b = processFixture(); b.process.skills[0].files[0].path = file
  expect(V2.parse(JSON.stringify(b)).ok).toBe(false)
})
