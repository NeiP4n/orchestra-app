import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import net from "node:net"

import { bounded as deadline, workClock } from "./fixture/probe-bounds"

async function refused(url: string): Promise<boolean> {
  const address = new URL(url)
  return await new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection({ host: address.hostname, port: Number(address.port) })
    socket.setTimeout(1500)
    socket.once("connect", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("timeout", () => {
      socket.destroy()
      reject(new Error("port probe timeout is NOT closure"))
    })
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") resolve(true)
      else reject(error)
    })
  })
}

for (const phase of ["early", "post-boot"] as const)
  for (const action of [
    "owner",
    "missing",
    "malformed",
    "EACCES",
    "schema-invalid",
    "SIGINT",
    "SIGTERM",
    "boot-failed",
  ] as const) {
    if (action === "boot-failed" && phase === "early") continue
    const unixSpecific = action === "EACCES" || action === "SIGINT" || action === "SIGTERM"
    const probe = unixSpecific && process.platform === "win32" ? test.skip : test
    probe(
      `CLI managed stop ${action === "boot-failed" ? "failed-boot state (no afterManagedStart)" : phase} ${action}${unixSpecific ? " (POSIX proof only)" : ""}`,
      async () => {
        const clock = workClock()
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-cli-stop-child-"))
        const env = {
          PATH: process.env.PATH!,
          HOME: root,
          TMPDIR: root,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          ORCHESTRA_TEST_HOME: root,
          ORCHESTRA_CONFIG_CONTENT: "{}",
          ORCHESTRA_CONFIG_PROJECT_DISABLE: "true",
          ORCHESTRA_DISABLE_MODELS_FETCH: "true",
          ORCHESTRA_DISABLE_FILEWATCHER: "true",
          ORCHESTRA_DISABLE_FFF: "true",
        }
        if (action === "boot-failed") {
          await fs.mkdir(path.join(root, "database-is-a-directory"))
          Object.assign(env, { ORCHESTRA_DB: path.join(root, "database-is-a-directory") })
        }
        const child = Bun.spawn(
          [
            process.execPath,
            path.join(import.meta.dir, "fixture/managed-stop-child.ts"),
            action === "boot-failed" ? "boot-failed" : phase,
          ],
          { env, cwd: root, stdout: "pipe", stderr: "pipe" },
        )
        let stdout = ""
        const stderr = new Response(child.stderr).text()
        const reader = child.stdout.getReader()
        const reading = (async () => {
          while (true) {
            const next = await reader.read()
            if (next.done) return
            stdout += new TextDecoder().decode(next.value)
          }
        })()
        try {
          let probe: { stage: string; file: string } | undefined
          const startupDeadline = clock.end
          while (!probe && Date.now() < startupDeadline && child.exitCode === null) {
            const matches = stdout
              .split("\n")
              .filter((l) => l.startsWith("PROBE "))
              .map((l) => JSON.parse(l.slice(6)))
            probe = matches.find((p) => p.stage === (action === "boot-failed" ? "early" : phase))
            if (!probe) await Bun.sleep(10)
          }
          if (!probe)
            throw new Error(
              "no phase ack: " +
                stdout +
                " stderr=" +
                (child.exitCode === null ? "still live" : await clock.wait(stderr, "startup stderr")),
            )
          const info = JSON.parse(await fs.readFile(probe.file, "utf8"))
          if (action === "boot-failed") {
            const failedBy = clock.end
            while (
              !stdout.includes("background service boot failed") &&
              Date.now() < failedBy &&
              child.exitCode === null
            )
              await Bun.sleep(10)
            if (!stdout.includes("background service boot failed"))
              throw new Error("real boot did not report its failure: " + stdout)
          }
          const status = await fetch(new URL("/api/info", info.url), {
            signal: AbortSignal.timeout(clock.remaining(3000)),
            headers: { authorization: "Basic " + btoa("opencode:" + info.password) },
          }).then((r) => r.status)
          expect(status).toBe(action === "boot-failed" ? 500 : phase === "early" ? 503 : 200)
          const incumbent = {
            ...info,
            id: "dummy-incumbent",
            pid: process.pid,
            password: "dummy-only",
            url: "http://127.0.0.1:1",
          }
          if (action === "owner" || action === "boot-failed") {
            await fs.writeFile(probe.file + ".replacement", JSON.stringify(incumbent))
            await fs.rename(probe.file + ".replacement", probe.file)
          } else if (action === "missing") await fs.rm(probe.file)
          else if (action === "malformed") await fs.writeFile(probe.file, "not JSON")
          else if (action === "schema-invalid")
            await fs.writeFile(
              probe.file,
              JSON.stringify({ password: "DUMMY_REGISTRATION_PASSWORD_MUST_NOT_LOG", id: false }),
            )
          else if (action === "EACCES") await fs.chmod(probe.file, 0)
          else child.kill(action)
          const exit = await clock.wait(child.exited, "child exit")
          // clock.wait rejects on timeout; a successful result is the numeric exit code.
          await clock.wait(reading, "stdout collection")
          const error = await clock.wait(stderr, "stderr collection")
          const closed = await refused(info.url)
          const preserved =
            action === "owner" || action === "boot-failed"
              ? JSON.stringify(JSON.parse(await fs.readFile(probe.file, "utf8"))) === JSON.stringify(incumbent)
              : null
          console.log(JSON.stringify({ phase, action, exit, status, closed, preserved, stdout, stderr: error }))
          if (action === "boot-failed") {
            expect(exit).toBe(1)
            expect(stdout + error).toContain("SQLiteError: unable to open database file")
            expect(stdout).not.toContain('"stage":"post-boot"')
            expect(preserved).toBe(true)
          } else if (action === "owner") {
            expect(exit).toBe(0)
            expect(preserved).toBe(true)
          } else if (action === "SIGINT" || action === "SIGTERM") expect(exit).toBe(130)
          else {
            expect(exit).toBe(1)
            expect(error).not.toContain("ManagedOwnershipLost")
            const expectedCause =
              action === "missing"
                ? "NotFound"
                : action === "malformed" || action === "schema-invalid"
                  ? "SchemaError"
                  : "PermissionDenied"
            expect(stdout + error).toContain(expectedCause)
            expect(stdout + error).toContain(JSON.stringify(probe.file).slice(1, -1))
            expect(stdout + error).not.toContain("DUMMY_REGISTRATION_PASSWORD_MUST_NOT_LOG")
            if (action === "missing")
              expect(
                await fs.stat(probe.file).then(
                  () => true,
                  () => false,
                ),
              ).toBe(false)
            if (action === "malformed") expect(await fs.readFile(probe.file, "utf8")).toBe("not JSON")
            if (action === "schema-invalid")
              expect(await fs.readFile(probe.file, "utf8")).toBe(
                JSON.stringify({ password: "DUMMY_REGISTRATION_PASSWORD_MUST_NOT_LOG", id: false }),
              )
            if (action === "EACCES") expect((await fs.stat(probe.file)).mode & 0o777).toBe(0)
          }
          expect(closed).toBe(true)
        } finally {
          try {
            if (child.exitCode === null) {
              child.kill("SIGKILL")
              await deadline(child.exited, 1000, "forced reap")
            }
          } finally {
            try {
              await deadline(Promise.all([reading, stderr]), 2000, "cleanup pipe collection")
            } finally {
              await deadline(fs.rm(root, { recursive: true, force: true }), 2000, "cleanup root")
            }
          }
        }
      },
      35000,
    )
  }
