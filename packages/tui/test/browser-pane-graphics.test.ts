import { test, expect } from "bun:test"
import path from "node:path"
test("browser graphics fallback runs in an isolated actual BrowserPane renderer", () => {
  const child = Bun.spawnSync([process.execPath, "test", "./test/fixture/browser-pane-graphics-cases.tsx"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, ORCHESTRA_BROWSER_GFX: "blocks", NO_COLOR: "1", FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = Buffer.from(child.stdout).toString() + Buffer.from(child.stderr).toString()
  expect(child.exitCode, output).toBe(0)
  expect(output).toContain("1 pass")
  expect(output).toContain("0 fail")
}, 30000)
