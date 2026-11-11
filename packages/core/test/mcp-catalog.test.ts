import { describe, expect, test } from "bun:test"
import type { ServerConfig } from "@orchestra/schema/mcp"
import { Effect } from "effect"
import {
  all,
  circuitBreaker,
  forPlatform,
  healthcheckServer,
  isServerAvailable,
  McpCircuitBreaker,
  missing,
} from "../src/mcp/catalog"

describe("MCP registry catalog", () => {
  test("includes the REA Anything launcher", () => {
    const rea = all.find((entry) => entry.id === "rea-anything")

    expect(rea).toMatchObject({
      id: "rea-anything",
      name: "REA — Reverse Engineer Anything",
      runtime: "npx",
      config: {
        type: "local",
        command: ["npx", "-y", "rea-agents@latest", "mcp"],
      },
    })
    expect(rea?.description).toContain("reverse engineering")
  })

  test("REA is available on Linux, macOS, and Windows", () => {
    expect(forPlatform("win32").some((entry) => entry.id === "rea-anything")).toBe(true)
    expect(forPlatform("linux").some((entry) => entry.id === "rea-anything")).toBe(true)
    expect(forPlatform("darwin").some((entry) => entry.id === "rea-anything")).toBe(true)
  })

  test("includes the xerj code-search launcher, loopback-only and never --insecure", () => {
    const xerj = all.find((entry) => entry.id === "xerj")

    expect(xerj).toMatchObject({
      id: "xerj",
      name: "Xerj",
      config: {
        type: "local",
        command: ["xerj", "mcp", "--url", "http://127.0.0.1:9200", "--disable-feedback"],
      },
    })
    expect(xerj?.description).toContain("Indexed retrieval")
    if (xerj?.config.type === "local") {
      expect(xerj.config.command.some((arg) => arg === "--insecure")).toBe(false)
      expect(xerj.config.command.some((arg) => arg.startsWith("http://127.0.0.1"))).toBe(true)
    }
  })

  test("retired browser MCP launchers are absent on every platform; native tools replace them", () => {
    for (const platform of ["win32", "linux", "darwin"] as const)
      for (const id of ["playwright", "chrome-devtools"])
        expect(forPlatform(platform).some((entry) => entry.id === id)).toBe(false)
  })

  test("desktop and GitHub MCP duplicates are removed, not hidden by platform", () => {
    for (const platform of ["win32", "linux", "darwin"] as const)
      for (const id of ["agent-desktop", "github"])
        expect(forPlatform(platform).some((entry) => entry.id === id)).toBe(false)
  })

  test("names the keys a catalog server cannot start without", () => {
    const sentry = all.find((entry) => entry.id === "sentry")!.config
    const previous = process.env.SENTRY_ACCESS_TOKEN
    delete process.env.SENTRY_ACCESS_TOKEN
    try {
      expect(missing("sentry", sentry)).toEqual(["SENTRY_ACCESS_TOKEN"])
      expect(missing("sentry", { ...sentry, environment: { SENTRY_ACCESS_TOKEN: "k" } } as ServerConfig)).toEqual([])
      if (sentry.type === "local")
        expect(missing("sentry", { ...sentry, command: [...sentry.command, "--access-token=k"] })).toEqual([])
      expect(missing("my-own-server", sentry)).toEqual([])
    } finally {
      if (previous !== undefined) process.env.SENTRY_ACCESS_TOKEN = previous
    }
  })

  test("McpCircuitBreaker isolates timeouts and failures without crashing fibers", async () => {
    const cb = new McpCircuitBreaker({ failureThreshold: 2, timeoutMs: 30 })

    // 1. Initial healthy state
    const initial = cb.getState("server-a")
    expect(initial.status).toBe("healthy")
    expect(cb.isAvailable("server-a")).toBe(true)

    // 2. Probe failure triggers degraded state without throwing
    const failProbe = Effect.fail(new Error("connection reset"))
    const failState = await Effect.runPromise(cb.check("server-a", failProbe))
    expect(failState.status).toBe("degraded")
    expect(failState.consecutiveFailures).toBe(1)
    expect(failState.lastError).toContain("connection reset")
    expect(cb.isAvailable("server-a")).toBe(true) // degraded allows trial requests

    // 3. Timeout triggers unhealthy state once threshold reached
    const slowProbe = Effect.sleep("60 millis").pipe(Effect.as("done"))
    const timeoutState = await Effect.runPromise(cb.check("server-a", slowProbe))
    expect(timeoutState.status).toBe("unhealthy")
    expect(timeoutState.consecutiveFailures).toBe(2)
    expect(timeoutState.lastError).toContain("Healthcheck timed out")
    expect(cb.isAvailable("server-a")).toBe(false) // circuit opened

    // 4. Recovery restores healthy state and resets consecutive failures
    const successProbe = Effect.succeed({ ping: "pong" })
    const recoveredState = await Effect.runPromise(cb.check("server-a", successProbe))
    expect(recoveredState.status).toBe("healthy")
    expect(recoveredState.consecutiveFailures).toBe(0)
    expect(recoveredState.consecutiveSuccesses).toBe(1)
    expect(cb.isAvailable("server-a")).toBe(true)
  })

  test("circuitBreaker tracks global availability and isolate/restore transitions", async () => {
    circuitBreaker.reset("test-server")

    // Record failure threshold
    circuitBreaker.recordFailure("test-server", "network error 1", { failureThreshold: 2 })
    expect(isServerAvailable("test-server")).toBe(true)
    expect(circuitBreaker.getState("test-server").status).toBe("degraded")

    circuitBreaker.recordFailure("test-server", "network error 2", { failureThreshold: 2 })
    expect(isServerAvailable("test-server")).toBe(false)
    expect(circuitBreaker.getState("test-server").status).toBe("unhealthy")

    // Healthcheck success restores it
    const success = await Effect.runPromise(healthcheckServer("test-server", Effect.succeed("ok")))
    expect(success.status).toBe("healthy")
    expect(isServerAvailable("test-server")).toBe(true)
  })
})

test("OFF healthcheck does not execute the supplied probe or count a failure", async () => {
  const breaker = new McpCircuitBreaker()
  let probes = 0
  const result = await Effect.runPromise(
    breaker.check(
      "off-server",
      Effect.sync(() => {
        probes++
      }),
      { disabled: true },
    ),
  )
  expect(probes).toBe(0)
  expect(result.lastCheckAt).toBe(0)
  expect(result.consecutiveFailures).toBe(0)
})
