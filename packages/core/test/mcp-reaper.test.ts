import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { McpReaper } from "@orchestra/core/mcp/reaper"

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
    fs.rmSync(state, { recursive: true, force: true })
  }
})

test("kills a whole process tree, not only the process that was started", async () => {
  // A parent that starts a child of its own and prints its pid.
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(child.pid); setInterval(() => {}, 1000)`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  )
  let output = ""
  parent.stdout!.on("data", (chunk) => (output += chunk))
  await until(() => /\d+/.test(output))
  const child = Number(output.trim())
  expect(alive(child)).toBe(true)

  McpReaper.killTree(parent.pid!)
  await until(() => !alive(parent.pid!) && !alive(child))

  expect(alive(parent.pid!)).toBe(false)
  expect(alive(child)).toBe(false)
})
