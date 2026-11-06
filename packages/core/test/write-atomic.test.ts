import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, readdir } from "node:fs/promises"
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

  test("a failed write leaves the previous file intact", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orchestra-write-atomic-"))
    const file = path.join(dir, "note.md")
    await WriteAtomic.writeAtomic(file, "original\n")
    await chmod(dir, 0o555)
    try {
      await expect(WriteAtomic.writeAtomic(file, "replacement\n")).rejects.toThrow()
    } finally {
      await chmod(dir, 0o755)
    }
    expect(await readFile(file, "utf8")).toBe("original\n")
    expect((await readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([])
  })
})
