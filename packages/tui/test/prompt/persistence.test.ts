import { expect, test } from "bun:test"
import path from "path"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { appendText, readJson, readText, writeJsonAtomic, writeText } from "../../src/util/persistence"

test("persistence creates parent directories and supports text, append, and JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-tui-persistence-"))
  try {
    const textPath = path.join(root, "nested", "state.jsonl")
    await writeText(textPath, "one\n")
    await appendText(textPath, "two\n")
    expect(await readText(textPath)).toBe("one\ntwo\n")

    const jsonPath = path.join(root, "other", "state.json")
    await writeJsonAtomic(jsonPath, { value: 1 })
    expect(await readJson<{ value: number }>(jsonPath)).toEqual({ value: 1 })
    await writeJsonAtomic(jsonPath, { value: 2 })
    expect(await readJson<{ value: number }>(jsonPath)).toEqual({ value: 2 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("atomic writes are readable before process exit and leave no temp files", async () => {
  const fs = await import("node:fs/promises")
  const os = await import("node:os")
  const path = await import("node:path")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "persist-on-write-"))
  try {
    const file = path.join(root, "browser-sessions.json")
    await writeJsonAtomic(file, { projects: { p: [{ id: "a" }] } })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ projects: { p: [{ id: "a" }] } })
    expect(await fs.readdir(root)).toEqual(["browser-sessions.json"])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("completed browser state write survives a killed writer without exit cleanup", async () => {
  const fs = await import("node:fs/promises")
  const os = await import("node:os")
  const path = await import("node:path")
  const { spawn } = await import("node:child_process")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "browser-kill-"))
  const file = path.join(root, "browser-sessions.json")
  const source = new URL("../../src/util/persistence.ts", import.meta.url).href
  const script = `import { writeJsonAtomic } from ${JSON.stringify(source)}; await writeJsonAtomic(${JSON.stringify(file)}, { sessions: ["persisted"] }); console.log("saved"); setInterval(() => {}, 1000);`
  const child = spawn(process.execPath, ["--eval", script], { stdio: ["ignore", "pipe", "pipe"] })
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()) })
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("writer did not confirm its write")), 5000)
      child.stdout!.once("data", () => { clearTimeout(timeout); resolve() })
      child.once("error", (error) => { clearTimeout(timeout); reject(error) })
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`writer exited before kill: ${code}`)) })
    })
    child.kill("SIGKILL")
    await exited
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ sessions: ["persisted"] })
  } finally { child.kill("SIGKILL"); await exited; await fs.rm(root, { recursive: true, force: true }) }
}, 10000)
