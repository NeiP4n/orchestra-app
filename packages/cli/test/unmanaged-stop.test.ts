import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { bounded, workClock } from "./fixture/probe-bounds"

test("no-lifecycle and legacy compatibility in an isolated subprocess", async () => {
  const clock = workClock(12000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-unmanaged-probe-"))
  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { jsx: "preserve", jsxImportSource: "@opentui/solid" } }),
  )
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/unmanaged-stop-child.ts")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH!,
      HOME: root,
      TMPDIR: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      ORCHESTRA_TEST_HOME: root,
      ORCHESTRA_CONFIG_CONTENT: "{}",
      ORCHESTRA_CONFIG_PROJECT_DISABLE: "true",
      ORCHESTRA_DISABLE_MODELS_FETCH: "true",
      ORCHESTRA_DISABLE_FILEWATCHER: "true",
      ORCHESTRA_DISABLE_FFF: "true",
    },
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  try {
    const code = await clock.wait(child.exited, "unmanaged compatibility exit")
    // clock.wait rejects on timeout; a successful result is the numeric exit code.
    const output = await clock.wait(stdout, "stdout")
    const error = await clock.wait(stderr, "stderr")
    console.log(JSON.stringify({ code, stdout: output, stderr: error }))
    expect(code).toBe(0)
    expect(output).toContain("PASS no-lifecycle")
    expect(output).toContain("PASS legacy")
    expect(output).toContain("PASS legacy-postboot")
  } finally {
    try {
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await bounded(child.exited, 1000, "forced reap")
      }
    } finally {
      try {
        await bounded(Promise.all([stdout, stderr]), 2000, "pipe cleanup")
      } finally {
        await bounded(fs.rm(root, { recursive: true, force: true }), 2000, "root cleanup")
      }
    }
  }
}, 20000)
