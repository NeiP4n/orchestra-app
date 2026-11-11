import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { createServer, connect } from "node:net"
import { verifyStopped } from "../src/browser/activity"

test("stop is not confirmed while either the local port or the managed PID remains alive", async () => {
  await expect(verifyStopped({ portAlive: async () => true, pidAlive: () => false, sleep: async () => {}, attempts: 2 })).rejects.toThrow("не подтверждена")
  await expect(verifyStopped({ portAlive: async () => false, pidAlive: () => true, sleep: async () => {}, attempts: 2 })).rejects.toThrow("не подтверждена")
})

test("stop verification observes real child exit and local port closure", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })
  const server = createServer(socket => socket.end())
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const port = (server.address() as { port: number }).port
  let exited = false
  const exit = new Promise<void>(done => child.once("exit", () => { exited = true; done() }))
  const portAlive = () => new Promise<boolean>(done => {
    const socket = connect(port, "127.0.0.1")
    socket.once("connect", () => { socket.destroy(); done(true) })
    socket.once("error", () => { socket.destroy(); done(false) })
  })
  try {
    expect(await portAlive()).toBe(true)
    expect(exited).toBe(false)
    child.kill()
    await exit
    await new Promise<void>(done => server.close(() => done()))
    await verifyStopped({ portAlive, pidAlive: () => !exited, sleep: ms => new Promise(done => setTimeout(done, ms)) })
    expect(await portAlive()).toBe(false)
    expect(exited).toBe(true)
  } finally { child.kill(); server.close() }
})

test("passive tab and image reads cannot restart a stopped Chrome", () => {
  const source = readFileSync(new URL("../src/browser/runtime.ts", import.meta.url), "utf8")
  const start = source.indexOf("export async function tabs(")
  const tabs = source.slice(start, source.indexOf("/** Moves the session", start))
  expect(tabs).not.toContain("await open(")
  expect(tabs).toContain("if (!item || item.client.isClosed?.()")
  const begin = source.indexOf("export async function watch(")
  const watch = source.slice(begin, source.indexOf("async function stream(", begin))
  expect(watch).not.toContain("await open(")
  expect(watch).toContain("live.get(sessionID)?.client")
  const stopStart = source.indexOf("export async function closeBlockedBrowser(")
  const stop = source.slice(stopStart, source.indexOf("async function start(", stopStart))
  expect(stop.indexOf("verifyStopped")).toBeLessThan(stop.indexOf('phase: "stopped"'))
  expect(stop).not.toContain('kill(pid, "SIGKILL")')
})
