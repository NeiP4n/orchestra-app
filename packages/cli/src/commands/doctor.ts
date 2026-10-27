import { EOL } from "node:os"
import net from "node:net"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Service } from "@orchestra/client/effect/service"
import { Commands } from "./commands"
import { Runtime } from "../framework/runtime"
import { ServiceConfig } from "../services/service-config"

export interface DoctorCheckResult {
  readonly id: string
  readonly name: string
  readonly status: "ok" | "warn" | "fail"
  readonly message: string
  readonly details?: Record<string, unknown>
}

export interface DoctorReport {
  readonly ok: boolean
  readonly timestamp: number
  readonly checks: ReadonlyArray<DoctorCheckResult>
  readonly summary: {
    readonly total: number
    readonly ok: number
    readonly warn: number
    readonly fail: number
  }
}

export async function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

export function checkRuntimes(env: {
  nodeVersion?: string
  bunVersion?: string
} = {}): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = []

  const bunVersion = env.bunVersion ?? (typeof process !== "undefined" ? process.versions?.bun : undefined)
  if (bunVersion) {
    results.push({
      id: "runtime.bun",
      name: "Bun Runtime",
      status: "ok",
      message: `Bun v${bunVersion} is available`,
      details: { version: bunVersion },
    })
  } else {
    results.push({
      id: "runtime.bun",
      name: "Bun Runtime",
      status: "fail",
      message: "Bun runtime not detected",
    })
  }

  const nodeVersion = env.nodeVersion ?? (typeof process !== "undefined" ? process.versions?.node : undefined)
  if (nodeVersion) {
    results.push({
      id: "runtime.node",
      name: "Node.js Runtime",
      status: "ok",
      message: `Node.js v${nodeVersion} is available`,
      details: { version: nodeVersion },
    })
  } else {
    results.push({
      id: "runtime.node",
      name: "Node.js Runtime",
      status: "fail",
      message: "Node.js runtime not detected",
    })
  }

  return results
}

export async function checkPorts(
  ports: ReadonlyArray<number> = [3000, 4096],
  checkAvailable: (port: number) => Promise<boolean> = isPortAvailable,
): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = []
  for (const port of ports) {
    const free = await checkAvailable(port)
    results.push({
      id: `port.${port}`,
      name: `Server Port ${port}`,
      status: free ? "ok" : "warn",
      message: free ? `Port ${port} is available` : `Port ${port} is currently in use`,
      details: { port, free },
    })
  }
  return results
}

export async function checkConfig(customPath?: string): Promise<DoctorCheckResult> {
  const candidatePaths = customPath
    ? [customPath]
    : [
        path.join(process.cwd(), "opencode.json"),
        path.join(process.cwd(), "orchestra.json"),
      ]

  let foundPath: string | undefined
  for (const p of candidatePaths) {
    try {
      await fs.access(p)
      foundPath = p
      break
    } catch {}
  }

  if (!foundPath) {
    return {
      id: "config.validation",
      name: "Configuration File",
      status: "ok",
      message: "No custom configuration file found (default configuration active)",
    }
  }

  try {
    const content = await fs.readFile(foundPath, "utf-8")
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        id: "config.validation",
        name: "Configuration File",
        status: "fail",
        message: `Invalid configuration structure in ${path.basename(foundPath)}: expected JSON object`,
        details: { path: foundPath },
      }
    }
    return {
      id: "config.validation",
      name: "Configuration File",
      status: "ok",
      message: `Configuration ${path.basename(foundPath)} is valid JSON`,
      details: { path: foundPath },
    }
  } catch (error) {
    return {
      id: "config.validation",
      name: "Configuration File",
      status: "fail",
      message: `Failed to parse ${path.basename(foundPath)}: ${error instanceof Error ? error.message : String(error)}`,
      details: { path: foundPath },
    }
  }
}

export const checkServiceStatus = Effect.gen(function* () {
  const options = yield* ServiceConfig.options().pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )

  if (!options) {
    return {
      id: "service.status",
      name: "Background Daemon",
      status: "warn" as const,
      message: "Could not load service options",
    }
  }

  const found = yield* Service.discover({ ...options, version: undefined }).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )

  if (found?.url) {
    return {
      id: "service.status",
      name: "Background Daemon",
      status: "ok" as const,
      message: `Background daemon is running at ${found.url}`,
      details: { url: found.url },
    }
  }

  return {
    id: "service.status",
    name: "Background Daemon",
    status: "ok" as const,
    message: "Background daemon is stopped",
  }
})

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = []
  lines.push("Orchestra System Diagnostics Report")
  lines.push("===================================")

  for (const check of report.checks) {
    const badge = check.status === "ok" ? "[OK]" : check.status === "warn" ? "[WARN]" : "[FAIL]"
    lines.push(`${badge.padEnd(7)} ${check.name}: ${check.message}`)
  }

  lines.push("")
  lines.push(
    `Summary: ${report.summary.ok} passed, ${report.summary.warn} warnings, ${report.summary.fail} failures (total ${report.summary.total}).`,
  )
  lines.push(`System health: ${report.ok ? "HEALTHY" : "DEGRADED"}`)

  return lines.join(EOL)
}

export function runDoctorChecks(options: {
  ports?: ReadonlyArray<number>
  configPath?: string
  customCheckService?: Effect.Effect<DoctorCheckResult>
} = {}) {
  return Effect.gen(function* () {
    const runtimeChecks = checkRuntimes()
    const portChecks = yield* Effect.promise(() => checkPorts(options.ports))
    const configCheck = yield* Effect.promise(() => checkConfig(options.configPath))
    const serviceCheck: DoctorCheckResult = options.customCheckService
      ? yield* options.customCheckService
      : yield* checkServiceStatus

    const allChecks: ReadonlyArray<DoctorCheckResult> = [...runtimeChecks, ...portChecks, configCheck, serviceCheck]
    const okCount = allChecks.filter((c) => c.status === "ok").length
    const warnCount = allChecks.filter((c) => c.status === "warn").length
    const failCount = allChecks.filter((c) => c.status === "fail").length

    const report: DoctorReport = {
      ok: failCount === 0,
      timestamp: Date.now(),
      checks: allChecks,
      summary: {
        total: allChecks.length,
        ok: okCount,
        warn: warnCount,
        fail: failCount,
      },
    }
    return report
  })
}

export default Runtime.handler(
  Commands.commands.doctor,
  Effect.fn("cli.doctor")(function* (input) {
    const report = yield* runDoctorChecks()

    if (input.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
      return
    }

    process.stdout.write(formatDoctorReport(report) + EOL)
  }),
)
