import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { unlinkedPath } from "../src/project-template-path"

test("ordinary native and canonical temp paths work, but linked roots and ancestors do not", async () => {
  const raw = await mkdtemp(path.join(os.tmpdir(), "template-path-"))
  const root = await realpath(raw)
  try {
    expect(await unlinkedPath(raw)).toBe(true)
    expect(await unlinkedPath(root)).toBe(true)
    expect(await unlinkedPath("relative/path")).toBe(false)
    await mkdir(path.join(root, "real", "nested"), { recursive: true })
    await symlink(path.join(root, "real"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir")
    expect(await unlinkedPath(path.join(root, "alias"))).toBe(false)
    expect(await unlinkedPath(path.join(root, "alias", "nested"))).toBe(false)
    expect(await unlinkedPath(path.join(root, "real", "nested"))).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
