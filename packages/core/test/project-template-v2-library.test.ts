import { expect, test } from "bun:test"
import { realpath, mkdtemp, rm, mkdir, writeFile, readFile, symlink, link } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ProjectTemplateV2Library as L } from "../src/project-template-v2-library"
import { ProjectTemplateFiles as Files } from "../src/project-template-files"
import { ProjectTemplateV2 as V2 } from "../src/project-template-v2"
import { processFixture } from "./project-template-v2.test"
test("process capture bytes survive actual library save/restart/export/remember field-for-field", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-library-")))
  try {
    const p = V2.preview(JSON.stringify(processFixture())); if (!p.ok) throw Error(p.error)
    const first = L.local(root), saved = await first.saveSerialized(p.value.text, "factory", p.value.digest)
    const second = L.local(root), loaded = await second.preview("factory")
    expect(loaded).toEqual(p.value)
    expect(await second.list()).toEqual([{ id: "factory", state: "ready", name: p.value.bundle.name, digest: p.value.digest, version: 2 }])
    await expect(second.saveSerialized(p.value.text, "factory", p.value.digest)).rejects.toThrow()
    await expect(Files.load(saved.directory)).rejects.toThrow()
    const exported = await second.export("factory", root, "exported", p.value.digest)
    expect(await Files.loadWithCodec(exported.directory, V2)).toEqual(p.value)
    await second.remember(exported.directory, "another", p.value.digest)
    expect((await L.local(root).preview("another")).bundle).toEqual(processFixture())
    const modified = processFixture(); modified.process.roles[0].rules = "Changed after review"
    await writeFile(path.join(saved.directory, "template.json"), JSON.stringify(modified))
    await expect(second.export("factory", root, "changed", p.value.digest)).rejects.toThrow("changed after review")
  } finally { await rm(root, { recursive: true, force: true }) }
})
test("both codecs reject extra source files, links and changed reviewed bytes", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-files-")))
  try {
    const p = V2.preview(JSON.stringify(processFixture())); if (!p.ok) throw Error(p.error)
    await expect(Files.saveWithCodec(root, "wrong", p.value.text, "wrong", V2)).rejects.toThrow("changed after preview")
    const { directory } = await Files.saveWithCodec(root, "clean", p.value.text, p.value.digest, V2)
    await writeFile(path.join(directory, "data.txt"), "PRIVATE_CANARY")
    await expect(Files.loadWithCodec(directory, V2)).rejects.toThrow("only template.json")
    await rm(path.join(directory, "data.txt"))
    await mkdir(path.join(root, "sym")); await symlink(path.join(directory, "template.json"), path.join(root, "sym", "template.json"))
    await expect(Files.loadWithCodec(path.join(root, "sym"), V2)).rejects.toThrow("not a link")
    await mkdir(path.join(root, "hard")); await link(path.join(directory, "template.json"), path.join(root, "hard", "template.json"))
    await expect(Files.loadWithCodec(path.join(root, "hard"), V2)).rejects.toThrow("not a link")
    expect((await readFile(path.join(directory, "template.json"), "utf8"))).toBe(p.value.text)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("process library rejects Windows device directory names before writing", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-names-")))
  try {
    const p = V2.preview(JSON.stringify(processFixture())); if (!p.ok) throw Error(p.error)
    for (const name of ["con", "nul", "prn", "aux", "com1", "lpt9"]) await expect(L.local(root).saveSerialized(p.value.text, name, p.value.digest)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
