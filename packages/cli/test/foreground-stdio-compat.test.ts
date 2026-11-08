import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { bounded, isolatedEnv, workClock } from "./fixture/probe-bounds"

for (const mode of ["foreground", "stdio"] as const) {
  const processTest = mode === "foreground" && process.platform === "win32" ? test.skip : test
  processTest(
    `normal entry ${mode} compatibility${mode === "foreground" ? " (POSIX SIGTERM proof only)" : ""}`,
    async () => {
      const clock = workClock()
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-mode-probe-"))
      await fs.writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { jsx: "preserve", jsxImportSource: "@opentui/solid" } }),
      )
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "../src/index.ts"),
          "serve",
          "--port",
          "0",
          ...(mode === "stdio" ? ["--stdio"] : []),
        ],
        {
          env: { ...isolatedEnv(root), ORCHESTRA_SERVER_PASSWORD: "dummy-mode-password" },
          cwd: root,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      let stdout = ""
      const reader = child.stdout.getReader()
      const reading = (async () => {
        while (true) {
          const next = await reader.read()
          if (next.done) return
          stdout += new TextDecoder().decode(next.value)
        }
      })()
      const stderr = new Response(child.stderr).text()
      try {
        let url: string | undefined
        while (!url && Date.now() < clock.end && child.exitCode === null) {
          const line = stdout
            .split("\n")
            .find((line) => (mode === "stdio" ? line.startsWith('{"url":') : line.startsWith("server listening on ")))
          if (line) url = mode === "stdio" ? JSON.parse(line).url : line.slice("server listening on ".length)
          if (!url) await Bun.sleep(10)
        }
        if (!url) throw new Error("no listening announcement: " + stdout)
        expect(
          await fetch(new URL("/api/info", url), {
            signal: AbortSignal.timeout(clock.remaining(3000)),
            headers: { authorization: "Basic " + btoa("opencode:dummy-mode-password") },
          }).then((r) => r.status),
        ).toBe(200)
        if (mode === "stdio") child.stdin.end()
        else child.kill("SIGTERM")
        const code = await clock.wait(child.exited, "mode exit")
        const [, error] = await clock.wait(Promise.all([reading, stderr]), "mode pipes")
        const address = new URL(url)
        await clock.wait(
          new Promise<void>((resolve, reject) => {
            const socket = net.createConnection({ host: address.hostname, port: Number(address.port) })
            socket.setTimeout(1500)
            socket.once("connect", () => {
              socket.destroy()
              reject(new Error("port still accepts"))
            })
            socket.once("timeout", () => {
              socket.destroy()
              reject(new Error("port timeout is not closure"))
            })
            socket.once("error", (e: NodeJS.ErrnoException) => {
              socket.destroy()
              if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET") resolve()
              else reject(e)
            })
          }),
          "port closure",
        )
        console.log(JSON.stringify({ mode, code, stdout, stderr: error }))
        expect(code).toBe(mode === "stdio" ? 0 : 130)
        expect(stdout + error).not.toContain("ManagedOwnershipLost")
        expect(stdout + error).not.toContain("managed contender conceded ownership")
        const state = path.join(root, "data", "orchestra", "server-state.json")
        if (mode === "foreground") expect(JSON.parse(await fs.readFile(state, "utf8")).cleanShutdown).toBe(true)
        else
          expect(
            await fs.stat(state).then(
              () => true,
              () => false,
            ),
          ).toBe(false)
      } finally {
        try {
          if (child.exitCode === null) {
            child.kill("SIGKILL")
            await bounded(child.exited, 1000, "mode forced reap")
          }
        } finally {
          try {
            await bounded(Promise.all([reading, stderr]), 2000, "mode pipes cleanup")
          } finally {
            await bounded(fs.rm(root, { recursive: true, force: true }), 2000, "mode root cleanup")
          }
        }
      }
    },
    35000,
  )
}
