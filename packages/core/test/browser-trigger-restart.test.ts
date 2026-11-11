import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

test("browser queue and reserved delivery survive two abrupt service-process exits through real SQLite KV", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "browser-trigger-restart-"))
  try {
    for (const mode of ["queue", "reserve", "replay"]) {
      const child = Bun.spawnSync([process.execPath, "run", "./test/fixture/browser-trigger-restart.ts", mode], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: {
          ...process.env,
          ORCHESTRA_DATA_DIR: root,
          ORCHESTRA_DB: path.join(root, "restart.db"),
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = Buffer.from(child.stdout).toString() + Buffer.from(child.stderr).toString()
      expect(child.exitCode, output).toBe(0)
      expect(output).toContain(`browser-restart-${mode}-ok`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
