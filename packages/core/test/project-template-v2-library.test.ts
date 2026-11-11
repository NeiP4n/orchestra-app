import { Flock } from "@orchestra/util/flock"
import { expect, test } from "bun:test"
import { realpath, mkdtemp, rm, mkdir, writeFile, readFile, readdir, symlink, link } from "node:fs/promises"
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


test("process library transfers only reviewed self-contained bytes between separate installations", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-transfer-")))
  try {
    const source = path.join(root, "laptop-a"), destination = path.join(root, "laptop-b"), transfer = path.join(root, "transfer")
    for (const directory of [source, destination, transfer]) await mkdir(directory)
    // Unrelated application state must never be discovered or copied by an export.
    for (const name of ["cookies.json", "chats.db", "vault.enc", "accounts.json"])
      await writeFile(path.join(source, name), "PRIVATE_MACHINE_STATE_CANARY")
    const value = V2.preview(JSON.stringify(processFixture()))
    if (!value.ok) throw Error(value.error)
    await L.local(source).saveSerialized(value.value.text, "factory", value.value.digest)
    const portable = await L.local(source).export("factory", transfer, "portable", value.value.digest)
    expect(await readdir(portable.directory)).toEqual(["template.json"])
    const bytes = await readFile(path.join(portable.directory, "template.json"), "utf8")
    expect(bytes).not.toContain("PRIVATE_MACHINE_STATE_CANARY")
    expect(bytes).not.toContain(source)
    expect(bytes).not.toContain(destination)
    await L.local(destination).remember(portable.directory, "factory", value.value.digest)
    // Remove the first installation and transport medium. The second is independently readable.
    await rm(source, { recursive: true })
    await rm(transfer, { recursive: true })
    const restarted = await L.local(destination).preview("factory")
    expect(restarted).toEqual(value.value)
    expect(restarted.bundle.process.skills[0]?.files).toEqual(processFixture().process.skills[0]?.files)
    expect(await readdir(destination)).toEqual(["process-templates"])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("reviewed update preserves one template identity, refuses stale review, and survives retry", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-update-")))
  Flock.setGlobal({ state: path.join(root, "state") })
  try {
    const library = L.local(root), source = V2.preview(JSON.stringify(processFixture()))
    if (!source.ok) throw Error(source.error)
    await library.saveSerialized(source.value.text, "factory", source.value.digest)
    const changed = processFixture(); changed.process.playbook = "Updated process, reviewed explicitly."
    const next = V2.preview(JSON.stringify(changed)); if (!next.ok) throw Error(next.error)
    await expect(library.replaceSerialized(next.value.text, "factory", "stale-digest", next.value.digest)).rejects.toThrow("changed after preview")
    expect((await library.preview("factory")).digest).toBe(source.value.digest)
    await library.replaceSerialized(next.value.text, "factory", source.value.digest, next.value.digest)
    expect((await library.preview("factory")).bundle.process.playbook).toBe(changed.process.playbook)
    await library.replaceSerialized(next.value.text, "factory", source.value.digest, next.value.digest)
    expect(await library.list()).toHaveLength(1)
    expect((await readdir(root)).sort()).toEqual(["process-templates", "state"])
    expect(await readdir(path.join(root, "process-templates"))).toEqual(["factory"])
    expect(await readdir(path.join(root, "process-templates", "factory"))).toEqual(["template.json"])
    await expect(library.replaceSerialized(source.value.text, "missing", source.value.digest, source.value.digest)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("two different updates from the same reviewed base cannot both replace the template", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-update-race-")))
  Flock.setGlobal({ state: path.join(root, "state") })
  try {
    const library = L.local(root), source = V2.preview(JSON.stringify(processFixture()))
    if (!source.ok) throw Error(source.error)
    await library.saveSerialized(source.value.text, "factory", source.value.digest)
    const previews = ["First process", "Second process"].map(playbook => {
      const bundle = processFixture(); bundle.process.playbook = playbook
      const result = V2.preview(JSON.stringify(bundle)); if (!result.ok) throw Error(result.error)
      return result.value
    })
    const results = await Promise.allSettled(previews.map(next => library.replaceSerialized(next.text, "factory", source.value.digest, next.digest)))
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
    expect(previews.map(value => value.digest)).toContain((await library.preview("factory")).digest)
    expect(await library.list()).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
