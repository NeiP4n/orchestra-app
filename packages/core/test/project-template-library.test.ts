import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectTemplate } from "../src/project-template"
import { ProjectTemplateFiles } from "../src/project-template-files"
import { ProjectTemplateLibrary } from "../src/project-template-library"
import { templateFixture } from "./project-template.test"
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-library-"))
  roots.push(root)
  const project = path.join(root, "destination")
  await mkdir(project)
  const preview = ProjectTemplate.preview(JSON.stringify(templateFixture()))
  if (!preview.ok) throw Error()
  const source = await ProjectTemplateFiles.save(root, "source", preview.value.text, preview.value.digest)
  return {
    root,
    project,
    preview: preview.value,
    source: source.directory,
    library: ProjectTemplateLibrary.local(root),
  }
}
test("library remembers only reviewed config, exports create-only folders and stages inactive definitions", async () => {
  const f = await fixture()
  expect(await f.library.list()).toEqual([])
  await f.library.remember(f.source, "factory", f.preview.digest)
  expect((await f.library.list()).map((v) => [v.name, v.state, v.title])).toEqual([["factory", "ready", "Factory"]])
  expect((await f.library.preview("factory")).digest).toBe(f.preview.digest)
  const output = await f.library.export("factory", f.root, "share", f.preview.digest)
  expect(await readFile(path.join(output.directory, "template.json"), "utf8")).toBe(f.preview.text)
  const staged = await f.library.stage("factory", f.project, "factory", f.preview.digest, "1.0.0")
  expect(staged.checklist.active).toBe(false)
  expect(staged.checklist.localVaultSlots[0].state).toBe("empty")
  await expect(f.library.export("factory", f.root, "share", f.preview.digest)).rejects.toThrow()
  await expect(f.library.remember(f.source, "factory", f.preview.digest)).rejects.toThrow()
  await expect(f.library.stage("factory", f.project, "factory", f.preview.digest, "1.0.0")).rejects.toThrow()
})
test("changed preview bytes, traversal and links cannot create/export/stage records", async () => {
  const f = await fixture()
  await f.library.remember(f.source, "factory", f.preview.digest)
  await expect(f.library.export("factory", f.root, "share", "wrong")).rejects.toThrow("changed")
  await expect(f.library.preview("../source")).rejects.toThrow()
  const next = templateFixture()
  next.name = "Changed"
  await writeFile(path.join(f.root, "project-templates", "factory", "template.json"), JSON.stringify(next))
  await expect(f.library.stage("factory", f.project, "copy", f.preview.digest, "1.0.0")).rejects.toThrow("changed")
  await symlink(f.source, path.join(f.root, "project-templates", "linked"))
  expect((await f.library.list()).find((v) => v.name === "linked")?.state).toBe("invalid")
  await expect(f.library.preview("linked")).rejects.toThrow()
})
test("library never follows a linked application root or library directory", async () => {
  const f = await fixture()
  await symlink(f.project, path.join(f.root, "project-templates"))
  await expect(f.library.list()).rejects.toThrow("links")
  const alias = path.join(f.root, "alias")
  await symlink(f.project, alias)
  await expect(ProjectTemplateLibrary.local(alias).list()).rejects.toThrow("links")
})
