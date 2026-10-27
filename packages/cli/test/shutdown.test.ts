import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GracefulShutdownCoordinator } from "../src/services/shutdown"

describe("GracefulShutdownCoordinator (OPT-021)", () => {
  test("executes registered hooks in priority order", async () => {
    const executed: string[] = []
    let exitedWith: number | undefined

    const coordinator = new GracefulShutdownCoordinator({
      autoExit: true,
      onExit: (code) => {
        exitedWith = code
      },
    })

    coordinator.addHook({
      name: "low-priority",
      priority: 10,
      run: async () => {
        executed.push("low")
      },
    })

    coordinator.addHook({
      name: "high-priority",
      priority: 100,
      run: async () => {
        executed.push("high")
      },
    })

    coordinator.addHook({
      name: "medium-priority",
      priority: 50,
      run: () => {
        executed.push("medium")
      },
    })

    const summary = await coordinator.shutdown("SIGTERM", 0)

    expect(executed).toEqual(["high", "medium", "low"])
    expect(summary.ok).toBeTrue()
    expect(summary.executedHooks).toBe(3)
    expect(summary.failedHooks).toBe(0)
    expect(summary.signal).toBe("SIGTERM")
    expect(exitedWith).toBe(0)
  })

  test("guarantees PID file deletion and system locks release", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-shutdown-test-"))
    const pidFile = path.join(tmpDir, "service.pid")
    await fs.writeFile(pidFile, "12345", "utf-8")

    let lockReleased = false
    let exitedWith: number | undefined

    const coordinator = new GracefulShutdownCoordinator({
      autoExit: true,
      onExit: (code) => {
        exitedWith = code
      },
    })

    coordinator.registerPidFile(pidFile)
    coordinator.registerLock(() => {
      lockReleased = true
    })

    expect(await fs.exists(pidFile)).toBeTrue()

    const summary = await coordinator.shutdown("SIGINT", 0)

    expect(await fs.exists(pidFile)).toBeFalse()
    expect(lockReleased).toBeTrue()
    expect(summary.pidFilesRemoved).toBe(1)
    expect(summary.locksReleased).toBe(1)
    expect(summary.ok).toBeTrue()
    expect(exitedWith).toBe(0)

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("triggers protective timeout when hooks hang", async () => {
    let forceExitedWith: number | undefined

    const coordinator = new GracefulShutdownCoordinator({
      timeoutMs: 40,
      autoExit: true,
      onExit: (code) => {
        forceExitedWith = code
      },
    })

    coordinator.addHook({
      name: "hanging-operation",
      run: () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
    })

    const summary = await coordinator.shutdown("SIGTERM", 0)

    expect(summary.timedOut).toBeTrue()
    expect(summary.ok).toBeFalse()
    expect(summary.errors.length).toBeGreaterThan(0)
    expect(forceExitedWith).toBe(1)
  })

  test("handles signal dispatch and unlisten via EventEmitter", async () => {
    const emitter = new EventEmitter()
    let exitedWith: number | undefined
    const executed: string[] = []

    const coordinator = new GracefulShutdownCoordinator({
      autoExit: true,
      onExit: (code) => {
        exitedWith = code
      },
    })

    coordinator.addHook(() => {
      executed.push("clean-service")
    })

    coordinator.listen(["SIGINT", "SIGTERM"], emitter as any)
    expect(emitter.listenerCount("SIGINT")).toBe(1)
    expect(emitter.listenerCount("SIGTERM")).toBe(1)

    // Trigger SIGINT on emitter
    emitter.emit("SIGINT")

    // Allow async shutdown to settle
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(executed).toEqual(["clean-service"])
    expect(exitedWith).toBe(0)

    coordinator.unlisten(emitter as any)
    expect(emitter.listenerCount("SIGINT")).toBe(0)
    expect(emitter.listenerCount("SIGTERM")).toBe(0)
  })

  test("unsubscribes hooks cleanly before shutdown", async () => {
    const executed: string[] = []
    const coordinator = new GracefulShutdownCoordinator({ autoExit: false })

    const unsubscribe = coordinator.addHook(() => {
      executed.push("should-not-run")
    })

    coordinator.addHook(() => {
      executed.push("should-run")
    })

    unsubscribe()

    await coordinator.shutdown()
    expect(executed).toEqual(["should-run"])
  })

  test("ensures errors in individual hooks do not block remaining hooks and cleanup", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-shutdown-err-"))
    const pidFile = path.join(tmpDir, "fail-test.pid")
    await fs.writeFile(pidFile, "9999", "utf-8")

    const executed: string[] = []

    const coordinator = new GracefulShutdownCoordinator({ autoExit: false })

    coordinator.addHook({
      name: "failing-hook",
      priority: 10,
      run: () => {
        throw new Error("hook exploded")
      },
    })

    coordinator.addHook({
      name: "healthy-hook",
      priority: 5,
      run: () => {
        executed.push("healthy-done")
      },
    })

    coordinator.registerPidFile(pidFile)

    const summary = await coordinator.shutdown()

    expect(executed).toEqual(["healthy-done"])
    expect(summary.ok).toBeFalse()
    expect(summary.failedHooks).toBe(1)
    expect(summary.executedHooks).toBe(1)
    expect(summary.pidFilesRemoved).toBe(1)
    expect(await fs.exists(pidFile)).toBeFalse()

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("returns same promise if shutdown is called repeatedly (idempotency)", async () => {
    let runCount = 0
    const coordinator = new GracefulShutdownCoordinator({ autoExit: false })

    coordinator.addHook(async () => {
      runCount++
      await new Promise((r) => setTimeout(r, 20))
    })

    const p1 = coordinator.shutdown("SIGTERM")
    const p2 = coordinator.shutdown("SIGINT")

    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1).toBe(r2)
    expect(runCount).toBe(1)
  })
})
