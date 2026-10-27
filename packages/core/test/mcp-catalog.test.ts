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

  test("names the keys a catalog server cannot start without", () => {
    const brave = all.find((entry) => entry.id === "brave-search")!.config
    const previous = process.env.BRAVE_API_KEY
    delete process.env.BRAVE_API_KEY
    try {
      expect(missing("brave-search", brave)).toEqual(["BRAVE_API_KEY"])
      expect(missing("brave-search", { ...brave, environment: { BRAVE_API_KEY: "k" } } as ServerConfig)).toEqual([])
      if (brave.type === "local")
        expect(missing("brave-search", { ...brave, command: [...brave.command, "--brave-api-key=k"] })).toEqual([])
      expect(missing("my-own-server", brave)).toEqual([])
    } finally {
      if (previous !== undefined) process.env.BRAVE_API_KEY = previous
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
