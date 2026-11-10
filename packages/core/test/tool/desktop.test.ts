import { expect, test } from "bun:test"
import path from "node:path"

// The original screenshot/window/clipboard live assertions remain in manual/desktop-operator-live.ts,
// gated by the operator's existing grant. The default suite must prove refusal, not opt itself in.
test("real Windows desktop host refuses capture-only requests without real-screen approval", () => {
  const child = Bun.spawnSync([process.execPath, "test", "./test/fixture/desktop-windows-denial-cases.ts"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = Buffer.from(child.stdout).toString() + Buffer.from(child.stderr).toString()
  expect(child.exitCode, output).toBe(0)
  expect(output).toContain("1 pass")
  expect(output).toContain("0 fail")
}, 30000)
