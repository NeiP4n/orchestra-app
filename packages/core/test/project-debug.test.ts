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

test("numeric per-event token usage survives redaction but token credentials do not",()=>fixture(async directory=>{
 await ProjectDebug.setEnabled(directory,true)
 const tokens={input:11,output:7,reasoning:3,cache:{read:5,write:2}}
 for(const eventType of ["session.step.ended","session.step.failed","session.usage.recorded","session.usage.updated"]){
  expect(ProjectDebug.eventTypes.has(eventType)).toBe(true)
  await ProjectDebug.record(directory,{...event(),eventType,data:{tokens,cost:0.25,apiToken:"secret",nested:{tokens:"credential"}}})
 }
 const rows=(await readFile(ProjectDebug.logPath(directory),"utf8")).trim().split("\n").map(line=>JSON.parse(line))
 for(const row of rows){expect(row.data.tokens).toEqual(tokens);expect(row.data.cost).toBe(0.25);expect(row.data.apiToken).toBe("[redacted]");expect(row.data.nested.tokens).toBe("[redacted]")}
 expect(ProjectDebug.redact({tokens:{...tokens,access_token:"secret"}})).toEqual({tokens:"[redacted]"})
}))

test("retry timeline retains failed attempt usage and retry scheduling without a success event",()=>fixture(async directory=>{
 await ProjectDebug.setEnabled(directory,true)
 const tokens={input:11,output:5,reasoning:2,cache:{read:0,write:0}}
 for(const [eventType,data] of [["session.step.failed",{error:{type:"provider.invalid-output"},tokens}],["session.retry.scheduled",{attempt:1,delay:2000}]] as const)
  await ProjectDebug.record(directory,{timestamp:1,sessionID:"retry",role:"team-tester",eventType,data})
 const rows=(await readFile(ProjectDebug.logPath(directory),"utf8")).trim().split("\n").map(line=>JSON.parse(line))
 expect(rows.map(row=>row.eventType)).toEqual(["session.step.failed","session.retry.scheduled"])
 expect(rows[0].data.tokens).toEqual(tokens)
 expect(rows.some(row=>row.eventType==="session.step.ended")).toBe(false)
}))

test("rejects a log replaced with a hard link between lstat and open", () => fixture(async directory => {
  const script = path.join(directory, "race.mjs")
  await writeFile(script, `
import { mock } from 'bun:test'
import * as fs from 'node:fs/promises'
import path from 'node:path'
const directory = process.argv[2]
const log = path.join(directory, '.orchestra/project-debug.jsonl')
const outside = path.join(directory, 'outside')
let armed = false, reads = 0
const originalLstat = fs.lstat
mock.module('node:fs/promises', () => ({ ...fs, lstat: async file => {
  const info = await originalLstat(file)
  if (armed && file === log && ++reads === 2) { await fs.unlink(log); await fs.link(outside, log) }
  return info
} }))
const { ProjectDebug } = await import(process.argv[3])
await ProjectDebug.setEnabled(directory, true)
const event = { timestamp: 1, sessionID: 'race', role: 'user', eventType: 'test', data: 'safe' }
await ProjectDebug.record(directory, event)
await fs.writeFile(outside, 'untouched', { mode: 0o644 })
armed = true
let rejected = false
try { await ProjectDebug.record(directory, event) } catch { rejected = true }
console.log(JSON.stringify({ rejected, value: await fs.readFile(outside, 'utf8'), mode: (await fs.stat(outside)).mode & 0o777 }))
`)
  const child = Bun.spawn([process.execPath, script, directory, path.resolve(import.meta.dir, "../src/session/project-debug.ts")], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
  expect(JSON.parse(output)).toEqual({ rejected: true, value: "untouched", mode: 0o644 })
}))
