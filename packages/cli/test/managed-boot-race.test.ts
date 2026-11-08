import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bounded, isolatedEnv, workClock } from "./fixture/probe-bounds"
for (const action of ["concurrent", "cleanup-fault"] as const)
  test(`real lifecycle failed boot with ${action}`, async () => {
    const clock = workClock(12000)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-boot-race-"))
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixture/managed-boot-race-child.ts"), action],
      { env: isolatedEnv(root), cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    try {
      const code = await clock.wait(child.exited, "boot-race exit")
      const [out, err] = await clock.wait(Promise.all([stdout, stderr]), "boot-race pipes")
      console.log(JSON.stringify({ action, code, stdout: out, stderr: err }))
      expect(code).toBe(1)
      expect(out).toContain('"originalBootIdentity":true')
      if (action === "cleanup-fault") expect(out).toContain('"cleanupIdentity":true')
    } finally {
      try {
        if (child.exitCode === null) {
          child.kill("SIGKILL")
          await bounded(child.exited, 1000, "boot-race forced reap")
        }
      } finally {
        try {
          await bounded(Promise.all([stdout, stderr]), 2000, "boot-race pipe cleanup")
        } finally {
          await bounded(fs.rm(root, { recursive: true, force: true }), 2000, "boot-race root cleanup")
        }
      }
    }
  }, 20000)
