import { expect, test } from "bun:test"
import path from "node:path"

// Preserve the complete Vault redaction/ownership contract without replacing Session or ToolFailure
// in the process shared by hundreds of unrelated suites. The child's mocks die with that child.
test("actual Vault tool redaction and verified-project contract in an isolated process", () => {
  const child = Bun.spawnSync([process.execPath, "test", "./test/fixture/vault-tool-cases.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = Buffer.from(child.stdout).toString() + Buffer.from(child.stderr).toString()
  expect(child.exitCode, output).toBe(0)
  expect(output).toContain("1 pass")
  expect(output).toContain("0 fail")
}, 30_000)
