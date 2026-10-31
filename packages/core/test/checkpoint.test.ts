import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseStatus, readChanges } from "@orchestra/core/checkpoint/changes"
import { gc, list, preview, remove, restore, save } from "@orchestra/core/checkpoint/engine"
import { renderList, renderPreview, renderSave } from "@orchestra/core/checkpoint/render"
import { getObject, layout, putObject } from "@orchestra/core/checkpoint/store"

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-checkpoint-"))
  roots.push(root)
  git(root, "init", "-q")
  write(root, "tracked.txt", "one\n")
  write(root, "removed.txt", "gone\n")
  git(root, "add", ".")
  git(root, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init")
  return root
}

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", "-C", root, ...args], stdout: "pipe", stderr: "pipe", windowsHide: true })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`)
  return new TextDecoder().decode(result.stdout)
}

function write(root: string, file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), content)
}

const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), "utf8")

describe("git changes", () => {
  test("parseStatus reads modified, untracked, deleted and renamed records from -z output", () => {
    const changes = parseStatus("R  new.txt\0old.txt\0 M plain.txt\0?? fresh.txt\0 D gone.txt\0")

    expect(changes).toEqual([
      { path: "new.txt", kind: "renamed", from: "old.txt" },
      { path: "plain.txt", kind: "modified" },
      { path: "fresh.txt", kind: "untracked" },
      { path: "gone.txt", kind: "deleted" },
    ])
  })

  test("readChanges reports the real working tree and refuses a directory that is not a repository", () => {
    const root = repository()
    write(root, "tracked.txt", "two\n")
    write(root, "fresh.txt", "fresh\n")
    fs.rmSync(path.join(root, "removed.txt"))

    const changes = readChanges(root)
    expect(changes.find((change) => change.path === "tracked.txt")?.kind).toBe("modified")
    expect(changes.find((change) => change.path === "fresh.txt")?.kind).toBe("untracked")
    expect(changes.find((change) => change.path === "removed.txt")?.kind).toBe("deleted")

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-plain-"))
    roots.push(plain)
    expect(() => readChanges(plain)).toThrow(/not a git repository/)
  })
})

describe("checkpoint save", () => {
  test("stores changed content, keeps deletions as entries and leaves the checkpoint folder out", () => {
    const root = repository()
    write(root, "tracked.txt", "two\n")
    write(root, "fresh.txt", "fresh\n")
    fs.rmSync(path.join(root, "removed.txt"))

    const moment = save(root, { name: "test" })
    const byPath = new Map(moment.files.map((file) => [file.path, file]))

    expect(moment.name).toBe("test")
    expect([...byPath.keys()].sort()).toEqual(["fresh.txt", "removed.txt", "tracked.txt"])
    expect(byPath.get("tracked.txt")).toMatchObject({ kind: "modified", size: 4 })
    expect(byPath.get("fresh.txt")).toMatchObject({ kind: "untracked", size: 6 })
    expect(byPath.get("removed.txt")).toMatchObject({ kind: "deleted" })
    expect(byPath.get("removed.txt")?.hash).toBeUndefined()
    expect(moment.bytes).toBe(10)
    expect(moment.stored).toBeGreaterThan(0)

    expect(fs.existsSync(layout(root).index)).toBe(true)
    expect(fs.readdirSync(layout(root).objects).length).toBe(2)
    expect(JSON.parse(fs.readFileSync(layout(root).index, "utf8")).moments).toHaveLength(1)
    expect(renderSave(moment)).toContain('Saved "test"')
  })

  test("a checkpoint folder that git does not ignore still stays out of the snapshot", () => {
    const root = repository()
    write(root, "tracked.txt", "two\n")
    save(root, { name: "first" })

    expect(fs.existsSync(path.join(root, ".orchestra", "checkpoints", "index.json"))).toBe(true)
    expect(readChanges(root).some((change) => change.path.startsWith(".orchestra/checkpoints"))).toBe(false)
  })

  test("an explicit name is protected from overwrite until force is passed", () => {
    const root = repository()
    write(root, "tracked.txt", "two\n")
    const first = save(root, { name: "dup" })

    write(root, "tracked.txt", "three\n")
    expect(() => save(root, { name: "dup" })).toThrow(/already exists/)

    const replaced = save(root, { name: "dup", force: true })
    const named = list(root).filter((moment) => moment.name === "dup")

    expect(named).toHaveLength(1)
    expect(named[0]?.id).toBe(replaced.id)
    expect(named[0]?.id).not.toBe(first.id)
    expect(replaced.files.find((file) => file.path === "tracked.txt")?.size).toBe(6)
  })

  test("an unchanged project saves an empty checkpoint instead of failing", () => {
    const root = repository()
    const moment = save(root, { name: "clean" })

    expect(moment.files).toEqual([])
    expect(moment.bytes).toBe(0)
    expect(list(root)[0]?.id).toBe(moment.id)
  })
})

describe("checkpoint restore", () => {
  test("writes saved content back, removes a file the snapshot saw deleted and keeps unknown paths", () => {
    const root = repository()
    write(root, "tracked.txt", "two\n")
    write(root, "fresh.txt", "fresh\n")
    fs.rmSync(path.join(root, "removed.txt"))
    const moment = save(root, { name: "before" })

    write(root, "tracked.txt", "three\n")
    write(root, "removed.txt", "back\n")
    write(root, "extra.txt", "extra\n")

    const report = restore(root, moment.id)

    expect(read(root, "tracked.txt")).toBe("two\n")
    expect(read(root, "fresh.txt")).toBe("fresh\n")
    expect(fs.existsSync(path.join(root, "removed.txt"))).toBe(false)
    expect(read(root, "extra.txt")).toBe("extra\n")
    expect(report.written).toBe(1)
    expect(report.deleted).toBe(1)
    expect(report.safety).toBeDefined()
  })

  test("the safety checkpoint makes a restore itself undoable", () => {
    const root = repository()
    write(root, "tracked.txt", "two\n")
    const moment = save(root, { name: "two" })

    write(root, "tracked.txt", "three\n")
    const report = restore(root, moment.id)
    expect(read(root, "tracked.txt")).toBe("two\n")

    const undo = restore(root, report.safety!)
    expect(read(root, "tracked.txt")).toBe("three\n")
    expect(undo.moment.name.startsWith("before-restore")).toBe(true)
  })

  test("a restore with no changes in the tree writes nothing and takes no safety snapshot", () => {
    const root = repository()
    write(root, "tracked.txt", "two\n")
    const moment = save(root, { name: "same" })

    const report = restore(root, moment.id)
    expect(report.written).toBe(0)
    expect(report.deleted).toBe(0)
    expect(report.safety).toBeUndefined()
  })

  test("a missing object fails loudly instead of leaving a half-restored tree", () => {
    const root = repository()
    write(root, "tracked.txt", "two\n")
    const moment = save(root, { name: "gone" })
    const hash = moment.files.find((file) => file.path === "tracked.txt")!.hash!
    fs.rmSync(path.join(layout(root).objects, `${hash}.zst`))

    write(root, "tracked.txt", "three\n")
    expect(() => restore(root, moment.id)).toThrow(/object .* is missing/)
    expect(read(root, "tracked.txt")).toBe("three\n")
  })

  test("an unknown checkpoint id is an error, not a silent no-op", () => {
    const root = repository()
    expect(() => restore(root, "cp_nope")).toThrow(/no checkpoint matches/)
  })
})

describe("checkpoint list, preview and gc", () => {
  test("list returns checkpoints newest first", () => {
    const root = repository()
    write(root, "tracked.txt", "two\n")
    const older = save(root, { name: "older" })
    write(root, "tracked.txt", "three\n")
    const newer = save(root, { name: "newer" })

    const moments = list(root)
    expect(moments.map((moment) => moment.id)).toEqual([newer.id, older.id])
    expect(renderList(moments)).toContain('"newer"')
  })

  test("preview describes the restore without touching a file", () => {
    const root = repository()
    write(root, "tracked.txt", "two\n")
    write(root, "gone.txt", "hello\n")
    const moment = save(root, { name: "preview" })

    write(root, "tracked.txt", "three\n")
    write(root, "later.txt", "later\n")
    const result = preview(root, "preview")

    expect(result.writes).toBe(1)
    expect(result.files.find((file) => file.path === "tracked.txt")?.action).toBe("write")
    expect(result.files.find((file) => file.path === "gone.txt")?.action).toBe("unchanged")
    expect(result.extra).toEqual(["later.txt"])
    expect(read(root, "tracked.txt")).toBe("three\n")
    expect(renderPreview(result)).toContain("would write 1")
    expect(result.moment.id).toBe(moment.id)
  })

  test("deleting a checkpoint and running gc removes the objects only it used", () => {
    const root = repository()
    write(root, "tracked.txt", "two\n")
    const keep = save(root, { name: "keep" })
    write(root, "tracked.txt", "three\n")
    const drop = save(root, { name: "drop" })

    expect(fs.readdirSync(layout(root).objects).length).toBe(2)
    remove(root, drop.id)
    const report = gc(root)

    expect(report.removed).toBe(1)
    expect(report.kept).toBe(1)
    const keptHash = keep.files.find((file) => file.path === "tracked.txt")!.hash!
    expect(fs.existsSync(path.join(layout(root).objects, `${keptHash}.zst`))).toBe(true)
  })

  test("identical content is stored once", () => {
    const root = repository()
    const data = new TextEncoder().encode("the same bytes")
    const first = putObject(root, data)
    const second = putObject(root, data)

    expect(first.fresh).toBe(true)
    expect(second.fresh).toBe(false)
    expect(second.hash).toBe(first.hash)
    expect(new TextDecoder().decode(getObject(root, first.hash))).toBe("the same bytes")
  })
})
