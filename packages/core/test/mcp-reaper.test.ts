import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { McpReaper } from "@orchestra/core/mcp/reaper"

const originalState = process.env.ORCHESTRA_STATE_DIR
afterEach(() => expect(process.env.ORCHESTRA_STATE_DIR).toBe(originalState))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const until = async (done: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !done(); attempt++) await Bun.sleep(50)
}

test("a service that died without closing its MCP servers has them killed by the next one, and only them", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reaper-"))
  const previousState = process.env.ORCHESTRA_STATE_DIR
  process.env.ORCHESTRA_STATE_DIR = state
  const forgotten = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  const innocent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  try {
    const registry = [
      // Its owner is gone: this one is reaped.
      { pid: forgotten.pid!, owner: 2_147_000, server: "memory", command: process.execPath },
      // Its owner is this very process, which is alive: this one is left running.
      { pid: innocent.pid!, owner: process.pid, server: "other", command: process.execPath },
    ]
    fs.writeFileSync(path.join(state, "mcp-children.json"), JSON.stringify(registry))

    McpReaper.reap()
    await until(() => !alive(forgotten.pid!))

    expect(alive(forgotten.pid!)).toBe(false)
    expect(alive(innocent.pid!)).toBe(true)
    // What was reaped leaves the registry; the live owner's entry stays.
    expect(JSON.parse(fs.readFileSync(path.join(state, "mcp-children.json"), "utf8"))).toEqual([registry[1]])
  } finally {
    innocent.kill()
    forgotten.kill()
    if (previousState === undefined) delete process.env.ORCHESTRA_STATE_DIR
    else process.env.ORCHESTRA_STATE_DIR = previousState
    fs.rmSync(state, { recursive: true, force: true })
  }
})

test("kills a whole process tree, not only the process that was started", async () => {
  // A parent that starts a child of its own and prints its pid. Detached, so the parent
  // leads its own process group — the shape killTree's group kill is written for.
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(child.pid); setInterval(() => {}, 1000)`,
    ],
    { stdio: ["ignore", "pipe", "ignore"], detached: true },
  )
  let output = ""
  parent.stdout!.on("data", (chunk) => (output += chunk))
  await until(() => /\d+/.test(output))
  const child = Number(output.trim())
  expect(alive(child)).toBe(true)

  McpReaper.killTree(parent.pid!, process.execPath)
  await until(() => !alive(parent.pid!) && !alive(child))

  expect(alive(parent.pid!)).toBe(false)
  expect(alive(child)).toBe(false)
})

test("does not kill a process whose command line does not name the expected command", async () => {
  const innocent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  try {
    // A stale registry entry can point at a pid the OS reused for an unrelated program.
    McpReaper.killTree(innocent.pid!, "definitely-not-this-command")
    await Bun.sleep(200)
    expect(alive(innocent.pid!)).toBe(true)

    // The same process is killed when its command line does name the command.
    McpReaper.killTree(innocent.pid!, process.execPath)
    await until(() => !alive(innocent.pid!))
    expect(alive(innocent.pid!)).toBe(false)
  } finally {
    innocent.kill()
  }
})

test("writes the registry atomically, leaving valid JSON and no temp files", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reaper-atomic-"))
  const previousState = process.env.ORCHESTRA_STATE_DIR
  process.env.ORCHESTRA_STATE_DIR = state
  try {
    McpReaper.track({ pid: 123456, server: "memory", command: "node" })
    McpReaper.track({ pid: 123457, server: "other", command: "node" })
    McpReaper.untrack(123456)
    expect(JSON.parse(fs.readFileSync(path.join(state, "mcp-children.json"), "utf8"))).toEqual([
      { pid: 123457, owner: process.pid, server: "other", command: "node" },
    ])
    expect(fs.readdirSync(state)).toEqual(["mcp-children.json"])
  } finally {
    if (previousState === undefined) delete process.env.ORCHESTRA_STATE_DIR
    else process.env.ORCHESTRA_STATE_DIR = previousState
    fs.rmSync(state, { recursive: true, force: true })
  }
})
