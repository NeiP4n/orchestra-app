import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { ServerProcess } from "@orchestra/server/process"
import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import { it } from "../../core/test/lib/effect"
import { isServerReachable, probeLiveServer } from "../src/services/live-smoke"

// The live server the operator runs (default: the background service on
// its usual port). Override with ORCHESTRA_LIVE_URL to point the smoke
// test at another server; ORCHESTRA_LIVE_PASSWORD adds the authed
// /api/info check. The probe is read-only (GETs only), so it is safe to
// run against the live server at any time.
const LIVE_URL = process.env.ORCHESTRA_LIVE_URL ?? "http://127.0.0.1:17890"
const LIVE_PASSWORD = process.env.ORCHESTRA_LIVE_PASSWORD

// One quick probe at load: when the server is down the live tests SKIP
// instead of failing — a stopped server is not a broken server.
const liveReachable = await isServerReachable(LIVE_URL)

describe("live smoke probe (local test server)", () => {
  // The probe logic itself is verified here, against a real server booted
  // in-process on a random port — never against the live server.
  it.live("probes a local server read-only: /health ok, /api/info has pid", () =>
    Effect.gen(function* () {
      const server = yield* ServerProcess.start<never, never>(
        { hostname: "127.0.0.1", port: 0, password: "secret", database: { path: ":memory:" } },
        undefined,
      )
      const origin = HttpServer.formatAddress(server.address)
      const result = yield* Effect.promise(() => probeLiveServer(origin, { password: "secret" }))
      expect(result.health.status).toBe(200)
      expect(result.health.body).toMatchObject({ status: "ok" })
      expect(result.info?.status).toBe(200)
      expect(result.info?.hasPid).toBe(true)
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )

  it.live("probes without a password: /health only, no /api/info", () =>
    Effect.gen(function* () {
      const server = yield* ServerProcess.start<never, never>(
        { hostname: "127.0.0.1", port: 0, password: "secret", database: { path: ":memory:" } },
        undefined,
      )
      const origin = HttpServer.formatAddress(server.address)
      const result = yield* Effect.promise(() => probeLiveServer(origin))
      expect(result.health.status).toBe(200)
      expect(result.info).toBeUndefined()
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )

  test("an unreachable server is not reachable (skip signal, not a failure)", async () => {
    // Port 1 on loopback refuses connections; the probe must answer
    // false quickly instead of throwing.
    expect(await isServerReachable("http://127.0.0.1:1", 1000)).toBe(false)
  })

  test("a reachable server that answers unhealthy fails the probe", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ status: "degraded" }, { status: 503 }),
    })
    try {
      expect(await isServerReachable(`http://127.0.0.1:${server.port}`, 1000)).toBe(true)
      await expect(probeLiveServer(`http://127.0.0.1:${server.port}`)).rejects.toThrow("health answered 503")
    } finally {
      server.stop(true)
    }
  })
})

describe.skipIf(!liveReachable)("live server smoke (read-only)", () => {
  test("GET /health answers 200 with status ok", async () => {
    const result = await probeLiveServer(LIVE_URL, { password: LIVE_PASSWORD })
    expect(result.health.status).toBe(200)
    expect(result.health.body).toMatchObject({ status: "ok" })
  })

  test.skipIf(LIVE_PASSWORD === undefined)(
    "GET /api/info answers 200 with a pid (needs ORCHESTRA_LIVE_PASSWORD)",
    async () => {
      const result = await probeLiveServer(LIVE_URL, { password: LIVE_PASSWORD })
      expect(result.info?.status).toBe(200)
      expect(result.info?.hasPid).toBe(true)
    },
  )
})
