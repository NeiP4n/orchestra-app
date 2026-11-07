import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Context, Effect, FileSystem, Layer, Logger } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServerLifecycle } from "../src/services/server-lifecycle"

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))

async function dataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "orchestra-server-lifecycle-"))
}

/** A pid that is guaranteed dead: a child that already exited. */
async function deadPid() {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" })
  await child.exited
  return child.pid
}

const info = (port: number | null) =>
  ({
    pid: process.pid,
    hostname: "127.0.0.1",
    port,
    mode: "default",
    startedAt: new Date().toISOString(),
  }) as const

test("lock is exclusive and the refusal names the live holder", async () => {
  const directory = await dataDir()
  const lock = info(17891)
  try {
    expect(await run(ServerLifecycle.acquireLock(directory, lock))).toEqual(lock)
    const error = await run(ServerLifecycle.acquireLock(directory, lock)).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ServerLifecycle.ServerAlreadyRunningError)
    expect((error as Error).message).toContain(`pid ${process.pid}`)
    expect((error as Error).message).toContain("17891")
    expect(await fs.readdir(directory)).toContain("server-17891.lock")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("lock file name is per-port, and port-less for auto-assigned ports", () => {
  expect(ServerLifecycle.lockFile("/data", 17891)).toBe(path.join("/data", "server-17891.lock"))
  expect(ServerLifecycle.lockFile("/data", null)).toBe(path.join("/data", "server.lock"))
  expect(ServerLifecycle.stateFile("/data")).toBe(path.join("/data", "server-state.json"))
})

test("a stale lock from a dead pid is reclaimed", async () => {
  const directory = await dataDir()
  const lock = info(17892)
  try {
    await fs.writeFile(
      ServerLifecycle.lockFile(directory, 17892),
      JSON.stringify({
        pid: await deadPid(),
        hostname: "127.0.0.1",
        port: 17892,
        mode: "default",
        startedAt: "2026-11-06T00:00:00.000Z",
      }),
    )
    expect(await run(ServerLifecycle.acquireLock(directory, lock))).toEqual(lock)
    const holder = JSON.parse(await fs.readFile(ServerLifecycle.lockFile(directory, 17892), "utf8")) as { pid: number }
    expect(holder.pid).toBe(process.pid)
    await run(ServerLifecycle.releaseLock(directory, 17892))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("release only removes the owner's lock", async () => {
  const directory = await dataDir()
  try {
    await fs.writeFile(
      ServerLifecycle.lockFile(directory, 17893),
      JSON.stringify({
        pid: await deadPid(),
        hostname: "127.0.0.1",
        port: 17893,
        mode: "default",
        startedAt: "2026-11-06T00:00:00.000Z",
      }),
    )
    // A lock naming another (dead) pid is not ours: release leaves it alone.
    await run(ServerLifecycle.releaseLock(directory, 17893))
    expect(await fs.readdir(directory)).toContain("server-17893.lock")
    await run(ServerLifecycle.acquireLock(directory, info(17893)))
    await run(ServerLifecycle.releaseLock(directory, 17893))
    expect(await fs.readdir(directory)).not.toContain("server-17893.lock")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("previous run: first, then clean after a marked shutdown, unclean without one", async () => {
  const directory = await dataDir()
  try {
    expect(await run(ServerLifecycle.readPreviousRun(directory))).toEqual({ verdict: "first" })

    const first = await run(ServerLifecycle.readPreviousRun(directory))
    const firstInfo = info(17894)
    await run(ServerLifecycle.markStarted(directory, firstInfo, first))
    // No shutdown marker yet: the run is unclean.
    expect(await run(ServerLifecycle.readPreviousRun(directory))).toEqual({
      verdict: "unclean",
      pid: process.pid,
      startedAt: firstInfo.startedAt,
    })

    await run(ServerLifecycle.markStopped(directory, "signal SIGTERM"))
    const clean = await run(ServerLifecycle.readPreviousRun(directory))
    expect(clean.verdict).toBe("clean")
    expect(clean.pid).toBe(process.pid)
    expect(clean.reason).toBe("signal SIGTERM")
    expect(clean.endedAt).toBeDefined()
    // A clean shutdown drops the lock file.
    expect(await fs.readdir(directory)).not.toContain("server-17894.lock")

    // A new run after a clean one reports the clean previous run.
    const second = await run(ServerLifecycle.readPreviousRun(directory))
    const secondInfo = info(17894)
    await run(ServerLifecycle.markStarted(directory, secondInfo, second))
    const state = JSON.parse(await fs.readFile(ServerLifecycle.stateFile(directory), "utf8")) as {
      previousRun: { verdict: string }
      cleanShutdown: boolean
    }
    expect(state.previousRun.verdict).toBe("clean")
    expect(state.cleanShutdown).toBe(false)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a corrupt state file reads as unknown and never throws", async () => {
  const directory = await dataDir()
  try {
    await fs.writeFile(ServerLifecycle.stateFile(directory), "{not json")
    expect(await run(ServerLifecycle.readPreviousRun(directory))).toEqual({
      verdict: "unknown",
      detail: expect.stringContaining("corrupt"),
    })
    // A corrupt state still lets a new run start and overwrite it.
    const previous = await run(ServerLifecycle.readPreviousRun(directory))
    const lock = info(17895)
    await run(ServerLifecycle.markStarted(directory, lock, previous))
    expect(await run(ServerLifecycle.readPreviousRun(directory))).toEqual({
      verdict: "unclean",
      pid: process.pid,
      startedAt: lock.startedAt,
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("markStopped by another pid never clobbers the current run's state", async () => {
  const directory = await dataDir()
  try {
    // State naming a different pid (a newer run that started elsewhere).
    await fs.writeFile(
      ServerLifecycle.stateFile(directory),
      JSON.stringify({
        version: 1,
        pid: await deadPid(),
        hostname: "127.0.0.1",
        port: 17896,
        mode: "default",
        startedAt: "2026-11-06T00:00:00.000Z",
        cleanShutdown: false,
        lastShutdown: null,
        previousRun: null,
      }),
    )
    await run(ServerLifecycle.markStopped(directory, "signal SIGTERM"))
    const state = JSON.parse(await fs.readFile(ServerLifecycle.stateFile(directory), "utf8")) as {
      cleanShutdown: boolean
    }
    expect(state.cleanShutdown).toBe(false)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("server-state.json is created with owner-only permissions", async () => {
  const directory = await dataDir()
  try {
    const previous = await run(ServerLifecycle.readPreviousRun(directory))
    await run(ServerLifecycle.markStarted(directory, info(17897), previous))
    // Windows has no unix modes: files map to 0666 and owner-only protection comes
    // from the user-profile ACL; assert the mode only where the OS can enforce it.
    expect((await fs.stat(ServerLifecycle.stateFile(directory))).mode & 0o777).toBe(
      process.platform === "win32" ? 0o666 : 0o600,
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a failed clean-marker write is logged, not swallowed", async () => {
  const directory = await dataDir()
  try {
    const previous = await run(ServerLifecycle.readPreviousRun(directory))
    await run(ServerLifecycle.markStarted(directory, info(17898), previous))
    // Fail the marker write deterministically, for every uid: a read-only
    // data directory (chmod 0o555) cannot force a failure — root bypasses
    // permission bits, so the write would succeed and the warning would
    // never fire on root-run CI (the repo's location-layer tests document
    // the same fact). Instead the filesystem layer fails the rename of
    // the state temp file, which is the exact step a failed marker write
    // dies on; everything else is the real implementation, and the state
    // file is never touched.
    const failStateRename = { current: false }
    const flakyFileSystem = NodeFileSystem.layer.pipe(
      Layer.flatMap((context) => {
        const fs = Context.get(context, FileSystem.FileSystem)
        return Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          rename: (oldPath: string, newPath: string) =>
            failStateRename.current && newPath.endsWith("server-state.json")
              ? fs.rename(oldPath, path.join(path.dirname(newPath), "no-such-directory", "x"))
              : fs.rename(oldPath, newPath),
        })
      }),
    )
    failStateRename.current = true
    const logged: Array<unknown> = []
    await Effect.runPromise(
      ServerLifecycle.markStopped(directory, "signal SIGTERM").pipe(
        Effect.provide(flakyFileSystem),
        Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => logged.push(entry.message))])),
      ),
    )
    // Effect logs a warning as [message, ...args], not a plain string.
    expect(logged.some((message) => JSON.stringify(message).includes("clean-shutdown marker"))).toBe(true)
    const state = JSON.parse(await fs.readFile(ServerLifecycle.stateFile(directory), "utf8")) as {
      cleanShutdown: boolean
    }
    expect(state.cleanShutdown).toBe(false)
    // The failed write left no temp file behind.
    expect((await fs.readdir(directory)).filter((name) => name.includes(".tmp"))).toEqual([])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
