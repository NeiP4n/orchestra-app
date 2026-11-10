import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LegacySkillExportInventory as Inventory } from "../src/legacy-skill-export-inventory"
import { SkillFile } from "../src/config/plugin/skill-file"

const metadata = { "orchestra/export": { version: 1, files: ["SKILL.md", "guide.md"], dependencies: [] } }
const content = "# Work skill\nRead guide.md\n"

test("owning legacy inventory captures exact explicit files and source session availability only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-inventory-"))
  try {
    const directory = path.join(root, "project"), skillRoot = path.join(directory, "skills", "review")
    await mkdir(skillRoot, { recursive: true })
    await writeFile(path.join(skillRoot, "SKILL.md"), content)
    await writeFile(path.join(skillRoot, "guide.md"), "Read-only review.\r\n")
    await writeFile(path.join(skillRoot, "PRIVATE.md"), "NEIGHBOR_DATA_CANARY")
    const source = Inventory.fromMetadata(metadata, path.join(directory, "skills"), path.join(skillRoot, "SKILL.md"), content)
    expect(source).toMatchObject({ state: "ready", entry: "SKILL.md", origin: { kind: "config-skill-file" } })
    const skill = { id: "review", name: "Review", path: path.join(skillRoot, "SKILL.md"), legacyExport: source }
    const result = await Inventory.collect([{ sessionID: "ses_owned", directory, skills: [skill] }, { sessionID: "ses_other", directory, skills: [] }])
    expect(result.complete).toBe(true)
    expect(result.definitions[0].files).toEqual(["SKILL.md", "guide.md"])
    expect(result.assignments).toEqual([{ target: { kind: "session", sessionID: "ses_owned" }, skills: ["review"] }, { target: { kind: "session", sessionID: "ses_other" }, skills: [] }])
    expect(result.origins).toMatchObject([{ sessionID: "ses_owned", skill: "review", kind: "project-catalog-availability" }])
    expect(JSON.stringify(result)).not.toContain("NEIGHBOR_DATA_CANARY")
    await writeFile(path.join(skillRoot, "SKILL.md"), content + "changed")
    await expect(Inventory.collect([{ sessionID: "ses_owned", directory, skills: [skill] }])).rejects.toThrow("changed after discovery")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("legacy inventory refuses implicit file scans, injected assignments and unsafe paths", () => {
  expect(Inventory.fromMetadata(undefined, "/project/skills", "/project/skills/a/SKILL.md", content)).toBeUndefined()
  for (const manifest of [
    { ...metadata["orchestra/export"], target: { kind: "project" } },
    { ...metadata["orchestra/export"], origin: "user" },
    { ...metadata["orchestra/export"], files: ["SKILL.md", "../PRIVATE.md"] },
    { ...metadata["orchestra/export"], files: ["SKILL.md", "/etc/passwd"] },
    { ...metadata["orchestra/export"], files: ["SKILL.md", "guide.md", "GUIDE.md"] },
    { ...metadata["orchestra/export"], files: ["guide.md"] },
    { ...metadata["orchestra/export"], dependencies: ["review", "review"] },
  ]) expect(Inventory.fromMetadata({ "orchestra/export": manifest }, "/project/skills", "/project/skills/a/SKILL.md", content)).toEqual({ state: "invalid" })
})

test("legacy incomplete project inventory stays visibly empty and never adopts global skills", async () => {
  const result = await Inventory.collect([{ sessionID: "ses_local", directory: "/project", skills: [{ id: "local", name: "Local", path: "/project/skills/local/SKILL.md" }, { id: "global", name: "Global", path: "/home/user/skills/global/SKILL.md" }] }])
  expect(result).toEqual({ complete: false, definitions: [], assignments: [], origins: [] })
  expect(await Inventory.collect([{ sessionID: "ses_local", directory: "/project", skills: [{ id: "global", name: "Global", path: "/home/user/skills/global/SKILL.md" }] }])).toMatchObject({ complete: true, definitions: [], assignments: [{ skills: [] }] })
})

test("legacy dependency definitions cannot widen source-session catalog visibility", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-dependencies-"))
  try {
    const skillRoot = path.join(root, "skills", "review")
    await mkdir(skillRoot, { recursive: true })
    await writeFile(path.join(skillRoot, "SKILL.md"), content)
    await writeFile(path.join(skillRoot, "guide.md"), "Review")
    const legacyExport = Inventory.fromMetadata({ "orchestra/export": { ...metadata["orchestra/export"], dependencies: ["global-private"] } }, path.join(root, "skills"), path.join(skillRoot, "SKILL.md"), content)
    await expect(Inventory.collect([{ sessionID: "ses_local", directory: root, skills: [{ id: "review", name: "Review", path: path.join(skillRoot, "SKILL.md"), legacyExport }] }])).rejects.toThrow("not available in its source session")
    await rm(path.join(skillRoot, "guide.md"))
    await symlink(path.join(skillRoot, "SKILL.md"), path.join(skillRoot, "guide.md"))
    await expect(Inventory.collect([{ sessionID: "ses_local", directory: root, skills: [{ id: "review", name: "Review", path: path.join(skillRoot, "SKILL.md"), legacyExport }] }])).rejects.toThrow("cannot be captured safely")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("existing source owner parses the explicit manifest without changing runtime skill content", () => {
  const document = "---\nname: Review\nmetadata:\n  orchestra/export:\n    version: 1\n    files: [SKILL.md, guide.md]\n    dependencies: []\n---\n# Review\n"
  const parsed = SkillFile.parse("/project/skills", "/project/skills/review/SKILL.md", document)
  expect(parsed).toMatchObject({ _tag: "Parsed", skill: { id: "review", content: "# Review\n", legacyExport: { state: "ready", files: ["SKILL.md", "guide.md"], origin: { sourceDirectory: "/project/skills", definitionPath: "/project/skills/review/SKILL.md" } } } })
})
