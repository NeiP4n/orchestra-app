import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WriteAtomic } from "@orchestra/core/write-atomic"

describe("WriteAtomic", () => {
  test("replaces the file and leaves no temp file behind", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orchestra-write-atomic-"))
    const file = path.join(dir, "note.md")
    await WriteAtomic.writeAtomic(file, "one\n")
    expect(await readFile(file, "utf8")).toBe("one\n")
    await WriteAtomic.writeAtomic(file, "two\n")
    expect(await readFile(file, "utf8")).toBe("two\n")
    expect((await readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([])
  })

  test("a failed write leaves the previous destination intact", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orchestra-write-atomic-"))
    const file = path.join(dir, "note.md")
    await WriteAtomic.writeAtomic(file, "original\n")
    // Force the rename to fail deterministically, for every uid: replacing
    // the file with a non-empty directory makes renaming a file over it
    // fail (EISDIR). A read-only directory (chmod 0o555) cannot force a
    // failure — root bypasses permission bits, so the write would succeed
    // and the test would pass for the wrong reason on root-run CI.
    await rm(file)
    await mkdir(file)
    await writeFile(path.join(file, "keep.txt"), "keep\n")
    await expect(WriteAtomic.writeAtomic(file, "replacement\n")).rejects.toThrow()
    // The previous destination is untouched, and no temp file is left behind.
    expect(await readFile(path.join(file, "keep.txt"), "utf8")).toBe("keep\n")
    expect((await readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([])
  })
})
