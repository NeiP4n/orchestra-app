import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { bounded, isolatedEnv, workClock } from "./fixture/probe-bounds"

test("configured-port EADDRINUSE then early fallback ownership concession", async () => {
  using listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}, { status: 503 }) })
  const clock = workClock()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-fallback-probe-"))
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixture/managed-stop-child.ts"), "early", String(listener.port)],
    {
      env: isolatedEnv(root),
      cwd: root,
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
    let file: string | undefined
    while (!file && Date.now() < clock.end && child.exitCode === null) {
      const line = stdout.split("\n").find((line) => line.startsWith("PROBE "))
      if (line) {
        const ack = JSON.parse(line.slice(6))
        expect(ack.stage).toBe("early")
        file = ack.file
      }
      if (!file) await Bun.sleep(10)
    }
    if (!file) throw new Error("no early fallback acknowledgement: " + stdout)
    const info = JSON.parse(await fs.readFile(file, "utf8"))
    expect(new URL(info.url).port).not.toBe(String(listener.port))
    expect(
      await fetch(new URL("/api/info", info.url), {
        signal: AbortSignal.timeout(clock.remaining(3000)),
        headers: { authorization: "Basic " + btoa("opencode:" + info.password) },
      }).then((r) => r.status),
    ).toBe(503)
    const incumbent = { ...info, id: "dummy-incumbent", pid: process.pid, password: "dummy-only" }
    await fs.writeFile(file + ".new", JSON.stringify(incumbent))
    await fs.rename(file + ".new", file)
    const code = await clock.wait(child.exited, "fallback exit")
    const [, error] = await clock.wait(Promise.all([reading, stderr]), "fallback pipes")
    const url = new URL(info.url)
    await clock.wait(
      new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: url.hostname, port: Number(url.port) })
        socket.setTimeout(1500)
        socket.once("connect", () => {
          socket.destroy()
          reject(new Error("fallback port still accepts"))
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
      "fallback closure",
    )
    console.log(JSON.stringify({ code, stdout, stderr: error }))
    expect(code).toBe(0)
    expect(stdout).toContain("retrying on an OS-assigned port")
    expect(stdout).not.toContain('"stage":"post-boot"')
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(incumbent)
  } finally {
    try {
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await bounded(child.exited, 1000, "fallback forced reap")
      }
    } finally {
      try {
        await bounded(Promise.all([reading, stderr]), 2000, "fallback pipes cleanup")
      } finally {
        await bounded(fs.rm(root, { recursive: true, force: true }), 2000, "fallback root cleanup")
      }
    }
  }
}, 35000)
