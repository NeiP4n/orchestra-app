import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { bounded, workClock } from "./fixture/probe-bounds"

for (const action of ["owner", "missing", "schema-invalid"] as const)
  test(`normal no-hook CLI entry ${action}`, async () => {
    const clock = workClock()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-normal-stop-"))
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { jsx: "preserve", jsxImportSource: "@opentui/solid" } }),
    )
    const env = {
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
    }
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service", "--port", "0"],
      { env, cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const out = new Response(child.stdout).text()
    const err = new Response(child.stderr).text()
    try {
      const state = path.join(root, "state", "orchestra")
      let file: string | undefined
      const until = clock.end
      while (Date.now() < until && child.exitCode === null) {
        const names = await fs.readdir(state).catch(() => [] as string[])
        const name = names.find((name) => /^service(?:-[\w.-]+)?\.json$/.test(name))
        if (name) {
          file = path.join(state, name)
          break
        }
        await Bun.sleep(10)
      }
      if (!file) throw new Error("normal entry did not register")
      const info = JSON.parse(await fs.readFile(file, "utf8"))
      let status = 0
      while (Date.now() < until && child.exitCode === null) {
        status = await fetch(new URL("/api/info", info.url), {
          signal: AbortSignal.timeout(clock.remaining(1500)),
          headers: { authorization: "Basic " + btoa("opencode:" + info.password) },
        }).then((r) => r.status)
        if (status === 200) break
        await Bun.sleep(10)
      }
      expect(status).toBe(200)
      const injected = JSON.stringify({ id: false, password: "DUMMY_NORMAL_ENTRY_MUST_NOT_LOG" })
      const incumbent = { ...info, id: "dummy-incumbent", password: "dummy-incumbent", pid: process.pid }
      if (action === "owner") {
        await fs.writeFile(file + ".new", JSON.stringify(incumbent))
        await fs.rename(file + ".new", file)
      } else if (action === "missing") await fs.rm(file)
      else await fs.writeFile(file, injected)
      const code = await clock.wait(child.exited, "normal entry exit")
      const stdout = await clock.wait(out, "normal entry stdout")
      const stderr = await clock.wait(err, "normal entry stderr")
      console.log(JSON.stringify({ code, stdout, stderr }))
      expect(code).toBe(action === "owner" ? 0 : 1)
      if (action !== "owner") {
        expect(stdout + stderr).toContain(action === "missing" ? "NotFound" : "SchemaError")
        expect(stdout + stderr).toContain("read-registration")
        expect(stdout + stderr).toContain(file)
      }
      expect(stdout + stderr).not.toContain("DUMMY_NORMAL_ENTRY_MUST_NOT_LOG")
      expect(stdout + stderr).not.toContain("PROBE ")
      if (action === "schema-invalid") expect(await fs.readFile(file, "utf8")).toBe(injected)
      else if (action === "missing")
        expect(
          await fs.stat(file).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
      else expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(incumbent)
    } finally {
      try {
        if (child.exitCode === null) {
          child.kill("SIGKILL")
          await bounded(child.exited, 1000, "forced reap")
        }
      } finally {
        try {
          await bounded(Promise.all([out, err]), 2000, "pipe cleanup")
        } finally {
          await bounded(fs.rm(root, { recursive: true, force: true }), 2000, "root cleanup")
        }
      }
    }
  }, 35000)
