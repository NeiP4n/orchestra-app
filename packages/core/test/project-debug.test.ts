import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, link } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectDebug } from "../src/session/project-debug"
const event = (sessionID = "session-a", data: unknown = { text: "hello" }): ProjectDebug.Record => ({ timestamp: 1, sessionID, role: "user", eventType: "session.inbox.enqueued", data })
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "project-debug-"))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
test("OFF creates no file, ON records all project sessions once in one ordered file, OFF stops", () => fixture(async directory => {
  await ProjectDebug.record(directory, event())
  expect(await readdir(directory)).toEqual([])
  await ProjectDebug.setEnabled(directory, true)
  await Promise.all([ProjectDebug.record(directory, event("a")), ProjectDebug.record(directory, event("b"))])
  const lines = (await readFile(ProjectDebug.logPath(directory), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  expect(lines.map(row => row.sessionID)).toEqual(["a", "b"])
  await ProjectDebug.setEnabled(directory, false)
  await ProjectDebug.record(directory, event("c"))
  expect((await readFile(ProjectDebug.logPath(directory), "utf8")).trim().split("\n")).toHaveLength(2)
  expect(await readFile(path.join(directory, ".orchestra/.gitignore"), "utf8")).toContain("project-debug.jsonl")
}))
test("redacts structured headers/env and secret values inside messages before disk", () => fixture(async directory => {
  await ProjectDebug.setEnabled(directory, true)
  const secret = "synthetic-test-private-value"
  process.env.ORCHESTRA_TEST_TOKEN = secret
  try {
    await ProjectDebug.record(directory, event("a", { password: "private", env: { DB_KEY: "hidden" }, text: `Authorization: Bearer hidden\nDB_PASSWORD="two word secret"\n${secret}` }))
    const text = await readFile(ProjectDebug.logPath(directory), "utf8")
    for (const value of ["private", "hidden", "two word secret", secret]) expect(text).not.toContain(value)
    expect(text).toContain("[redacted]")
  } finally { delete process.env.ORCHESTRA_TEST_TOKEN }
}))
test("bounded rotation retains one backup and valid JSONL", () => fixture(async directory => {
  await ProjectDebug.setEnabled(directory, true)
  for (let i = 0; i < 8; i++) await ProjectDebug.record(directory, event(String(i), { text: "a".repeat(100) }), 500)
  for (const file of [ProjectDebug.logPath(directory), ProjectDebug.logPath(directory) + ".1"]) {
    const text = await readFile(file, "utf8")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(500)
    expect(text.trim().split("\n").map(line => JSON.parse(line)).length).toBeGreaterThan(0)
  }
}))
test("refuses symlink destinations and never writes outside project", () => fixture(async directory => {
  await ProjectDebug.setEnabled(directory, true)
  await symlink(path.join(directory, "outside"), ProjectDebug.logPath(directory))
  await expect(ProjectDebug.record(directory, event())).rejects.toThrow("symbolic")
  expect(await readdir(directory)).not.toContain("outside")
}))

test("environment requires exact opt-in and persisted OFF overrides it", () => fixture(async directory => {
  const previous = process.env.ORCHESTRA_PROJECT_DEBUG
  try {
    process.env.ORCHESTRA_PROJECT_DEBUG = "false"
    expect(await ProjectDebug.enabled(directory)).toBe(false)
    process.env.ORCHESTRA_PROJECT_DEBUG = "1"
    expect(await ProjectDebug.enabled(directory)).toBe(true)
    await ProjectDebug.record(directory, event())
    expect(await readFile(path.join(directory, ".orchestra/.gitignore"), "utf8")).toContain("project-debug.jsonl")
    await ProjectDebug.setEnabled(directory, false)
    expect(await ProjectDebug.enabled(directory)).toBe(false)
  } finally { if (previous === undefined) delete process.env.ORCHESTRA_PROJECT_DEBUG; else process.env.ORCHESTRA_PROJECT_DEBUG = previous }
}))

test("refuses corrupt settings even with environment opt-in", () => fixture(async directory => {
  await ProjectDebug.setEnabled(directory, false)
  await writeFile(path.join(directory, ".orchestra/debug-recording.json"), "broken")
  await expect(ProjectDebug.record(directory, event())).rejects.toThrow()
  expect(await readdir(path.join(directory, ".orchestra"))).not.toContain("project-debug.jsonl")
}))
test("refuses a hard-linked log without modifying the other file", () => fixture(async directory => {
  await ProjectDebug.setEnabled(directory, true)
  const outside = path.join(directory, "outside")
  await writeFile(outside, "untouched")
  await link(outside, ProjectDebug.logPath(directory))
  await expect(ProjectDebug.record(directory, event())).rejects.toThrow("hard links")
  expect(await readFile(outside, "utf8")).toBe("untouched")
}))

test("status reports last write and makes failed writes visible", () => fixture(async directory => {
  await ProjectDebug.setEnabled(directory, true)
  expect(await ProjectDebug.status(directory)).toMatchObject({ enabled: true, bytes: 0 })
  await ProjectDebug.record(directory, event())
  const status = await ProjectDebug.status(directory)
  expect(status.bytes).toBeGreaterThan(0)
  expect(status.lastWrite).toBeNumber()
  expect(status.path).toBe(ProjectDebug.logPath(directory))
  await rm(ProjectDebug.logPath(directory))
  await writeFile(path.join(directory, "outside"), "untouched")
  await link(path.join(directory, "outside"), ProjectDebug.logPath(directory))
  await expect(ProjectDebug.record(directory, event())).rejects.toThrow()
  await rm(ProjectDebug.logPath(directory))
  expect((await ProjectDebug.status(directory)).error).toContain("Recording failed")
  await ProjectDebug.record(directory, event())
  expect((await ProjectDebug.status(directory)).error).toBeUndefined()
}))
