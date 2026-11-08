import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bounded, isolatedEnv, workClock } from "./fixture/probe-bounds"

// Linux native FIFO/procfs proof only, never inferred to cover Windows.
const fifoTest = process.platform === "linux" ? test : test.skip
fifoTest(
  "Linux real pending FIFO registration read cancellation is not a check fault (isolated child)",
  async () => {
    const clock = workClock(12000)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-fifo-child-"))
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/registration-fifo-child.ts")], {
      env: isolatedEnv(root),
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    try {
      const code = await clock.wait(child.exited, "FIFO child exit")
      const [output, error] = await clock.wait(Promise.all([stdout, stderr]), "FIFO child pipes")
      console.log(JSON.stringify({ code, stdout: output, stderr: error }))
      expect(code).toBe(0)
      expect(output).toContain('"descriptorProof":2,"callbacks":0')
    } finally {
      try {
        if (child.exitCode === null) {
          child.kill("SIGKILL")
          await bounded(child.exited, 1000, "FIFO forced reap")
        }
      } finally {
        try {
          await bounded(Promise.all([stdout, stderr]), 2000, "FIFO pipe cleanup")
        } finally {
          await bounded(fs.rm(root, { recursive: true, force: true }), 2000, "FIFO root cleanup")
        }
      }
    }
  },
  20000,
)
