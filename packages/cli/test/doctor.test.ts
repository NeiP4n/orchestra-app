import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect } from "effect"
import { Global } from "@orchestra/util/global"
import {
  checkConfig,
  checkPorts,
  checkRuntimes,
  formatDoctorReport,
  isPortAvailable,
  runDoctorChecks,
} from "../src/commands/doctor"

describe("orchestra doctor diagnostics", () => {
  test("checkRuntimes reports available Bun and Node.js versions", () => {
    const results = checkRuntimes({
      bunVersion: "1.4.3",
      nodeVersion: "22.14.0",
    })

    expect(results).toHaveLength(2)
    const bunCheck = results.find((r) => r.id === "runtime.bun")
    const nodeCheck = results.find((r) => r.id === "runtime.node")

    expect(bunCheck?.status).toBe("ok")
    expect(bunCheck?.message).toContain("Bun v1.4.3")
    expect(nodeCheck?.status).toBe("ok")
    expect(nodeCheck?.message).toContain("Node.js v22.14.0")
  })

  test("checkRuntimes reports failure when runtimes are missing", () => {
    const results = checkRuntimes({
      bunVersion: "",
      nodeVersion: "",
    })

    const bunCheck = results.find((r) => r.id === "runtime.bun")
    const nodeCheck = results.find((r) => r.id === "runtime.node")

    expect(bunCheck?.status).toBe("fail")
    expect(nodeCheck?.status).toBe("fail")
  })

  test("checkPorts verifies available and occupied local ports", async () => {
    const mockCheckAvailable = async (port: number) => port === 3000

    const results = await checkPorts([3000, 4096], mockCheckAvailable)
    expect(results).toHaveLength(2)

    const port3000 = results.find((r) => r.id === "port.3000")
    const port4096 = results.find((r) => r.id === "port.4096")

    expect(port3000?.status).toBe("ok")
    expect(port3000?.message).toContain("Port 3000 is available")
    expect(port4096?.status).toBe("warn")
    expect(port4096?.message).toContain("Port 4096 is currently in use")
  })

  test("isPortAvailable returns true for unbound ephemeral ports", async () => {
    // 0 lets the OS pick an available ephemeral port
    const free = await isPortAvailable(0)
    expect(free).toBe(true)
  })

  test("checkConfig validates presence, valid JSON and invalid syntax", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-config-test-"))
    try {
      // 1. Missing file -> ok with default configuration
      const missingCheck = await checkConfig(path.join(tmpDir, "missing.json"))
      expect(missingCheck.status).toBe("ok")
      expect(missingCheck.message).toContain("default configuration active")

      // 2. Valid JSON -> ok
      const validPath = path.join(tmpDir, "opencode.json")
      await fs.writeFile(validPath, JSON.stringify({ model: "gemini", autoupdate: true }))
      const validCheck = await checkConfig(validPath)
      expect(validCheck.status).toBe("ok")
      expect(validCheck.message).toContain("is valid JSON")

      // 3. Malformed JSON -> fail
      const malformedPath = path.join(tmpDir, "broken.json")
      await fs.writeFile(malformedPath, "{ broken: true, invalid }")
      const brokenCheck = await checkConfig(malformedPath)
      expect(brokenCheck.status).toBe("fail")
      expect(brokenCheck.message).toContain("Failed to parse")
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  test("runDoctorChecks aggregates all diagnostics into comprehensive report", async () => {
    const report = await Effect.runPromise(
      runDoctorChecks({
        ports: [3000, 4096],
        customCheckService: Effect.succeed({
          id: "service.status",
          name: "Background Daemon",
          status: "ok",
          message: "Background daemon is stopped",
        }),
      }).pipe(
        Effect.provideService(Global.Service, Global.make()),
        Effect.provide(NodeFileSystem.layer),
      ),
    )

    expect(report.ok).toBeTrue()
    expect(report.checks.length).toBeGreaterThanOrEqual(4)
    expect(report.summary.total).toBe(report.checks.length)
    expect(report.summary.fail).toBe(0)

    const formatted = formatDoctorReport(report)
    expect(formatted).toContain("Orchestra System Diagnostics Report")
    expect(formatted).toContain("[OK]")
    expect(formatted).toContain("Summary:")
    expect(formatted).toContain("System health: HEALTHY")
  })

  test("runDoctorChecks executes real service discovery check without crashing", async () => {
    const report = await Effect.runPromise(
      runDoctorChecks({
        ports: [3000],
      }).pipe(
        Effect.provideService(Global.Service, Global.make()),
        Effect.provide(NodeFileSystem.layer),
      ),
    )

    expect(report).toBeDefined()
    expect(report.checks.some((c) => c.id === "service.status")).toBeTrue()
    expect(report.summary.total).toBeGreaterThanOrEqual(4)
  })
})
