import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TriggerBundleFiles as Files } from "@orchestra/core/trigger-bundle-files"
const text = JSON.stringify({
  format: "orchestra.trigger-bundle",
  version: 1,
  templates: [
    {
      slot: "template_1",
      secretSlots: ["github.token"],
      kind: "interval",
      spec: "10",
      maxPerHour: 3,
      maxPerDay: 20,
      missedPolicy: "skip",
    },
  ],
})
test("project files survive a new reader and stay separate in two selected projects", async () => {
  const a = await mkdtemp(path.join(os.tmpdir(), "triggers-a-")),
    b = await mkdtemp(path.join(os.tmpdir(), "triggers-b-"))
  try {
    const saved = await Files.save(a, "team", text)
    expect(saved).toBe(
      path.join(await import("node:fs/promises").then((fs) => fs.realpath(a)), ".orchestra", "triggers", "team.json"),
    )
    expect(await Files.load(a, "team")).toEqual(JSON.parse(text))
    await expect(Files.load(b, "team")).rejects.toThrow()
    await expect(Files.save(a, "team", text)).rejects.toThrow()
    expect(JSON.parse(await readFile(saved, "utf8"))).toEqual(JSON.parse(text))
    for (const name of ["../outside", "a/b", "token.json", "C:\\outside"])
      await expect(Files.save(a, name, text)).rejects.toThrow()
    await expect(Files.save(a, "bad", '{"password":"secret"}')).rejects.toThrow()
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})
test("rejects project folder junction/symlink escapes without reading or writing outside", async () => {
  const a = await mkdtemp(path.join(os.tmpdir(), "triggers-root-")),
    outside = await mkdtemp(path.join(os.tmpdir(), "triggers-out-"))
  try {
    await symlink(outside, path.join(a, ".orchestra"), process.platform === "win32" ? "junction" : "dir")
    await expect(Files.save(a, "team", text)).rejects.toThrow("real directory")
    await expect(Files.load(a, "team")).rejects.toThrow("real directory")
    await expect(readFile(path.join(outside, "triggers", "team.json"))).rejects.toThrow()
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
test("rejects oversized and malformed saved files before activation", async () => {
  const a = await mkdtemp(path.join(os.tmpdir(), "triggers-size-"))
  try {
    const dir = path.join(a, ".orchestra", "triggers")
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "huge.json"), "x".repeat(40_000))
    await expect(Files.load(a, "huge")).rejects.toThrow("too large")
    await writeFile(path.join(dir, "bad.json"), '{"enabled":true}')
    await expect(Files.load(a, "bad")).rejects.toThrow("Unsupported")
  } finally {
    await rm(a, { recursive: true, force: true })
  }
})
