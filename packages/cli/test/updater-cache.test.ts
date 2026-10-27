import { describe, expect, spyOn } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { Global } from "@orchestra/util/global"
import { AppProcess } from "@orchestra/util/process"
import { EffectFlock } from "@orchestra/util/effect-flock"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import path from "node:path"
import { Updater, DEFAULT_UPDATE_CACHE_TTL_MS } from "../src/services/updater"
import { testEffect } from "../../core/test/lib/effect"

const it = testEffect(NodeServices.layer)

function createFixture(options?: {
  readonly fetchHandler?: (url: string) => Promise<Response>
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-updater-cache-" })
    const modules = path.join(root, "node_modules")
    const executable = path.join(modules, "@orchestra", "cli", "bin", "orchestra")
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true })
    yield* fs.writeFileString(executable, "binary")
    yield* fs.writeFileString(
      path.join(modules, "@orchestra", "cli", "package.json"),
      JSON.stringify({ name: "@orchestra/cli", bin: { orchestra: "bin/orchestra" } }),
    )

    const requests: string[] = []
    const previousUpdateUrl = process.env.ORCHESTRA_UPDATE_URL
    process.env.ORCHESTRA_UPDATE_URL = "https://update.orchestra.test"

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previousUpdateUrl === undefined) {
          delete process.env.ORCHESTRA_UPDATE_URL
        } else {
          process.env.ORCHESTRA_UPDATE_URL = previousUpdateUrl
        }
      }),
    )

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async (input: string | URL | Request) => {
              const url = input instanceof Request ? input.url : input.toString()
              requests.push(url)
              if (options?.fetchHandler) {
                return options.fetchHandler(url)
              }
              return Response.json({
                version: "3.5.0",
                metadata: { package: "@orchestra/cli" },
              })
            },
            { preconnect: fetch.preconnect },
          ),
        ),
      ),
      (mock) => Effect.sync(() => mock.mockRestore()),
    )

    const global = Global.make({
      home: path.join(root, "home"),
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "tmp"),
      bin: path.join(root, "bin"),
      log: path.join(root, "log"),
      repos: path.join(root, "repos"),
    })

    const updater = yield* Updater.Service.pipe(
      Effect.provide(Updater.layer),
      Effect.provide(
        LayerNode.compile(EffectFlock.node, {
          replacements: [Global.node.replace(Layer.succeed(Global.Service, global))],
        }),
      ),
      Effect.provideService(Global.Service, global),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        realPath: (input) => (input === process.execPath ? Effect.succeed(executable) : fs.realPath(input)),
      }),
      Effect.provideService(
        AppProcess.Service,
        AppProcess.Service.of({
          ...spawner,
          run: () =>
            Effect.succeed({
              command: "npm",
              exitCode: 0,
              stdout: Buffer.from("@orchestra/cli@2.0.0"),
              stderr: Buffer.alloc(0),
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
          runStream: () => {
            throw new Error("Unexpected runStream call")
          },
        }),
      ),
    )

    return { updater, requests, global, fs }
  })
}

describe("Updater offline caching and TTL suite (OPT-022)", () => {
  it.live("1. Uses cache when valid without triggering network requests", () =>
    Effect.gen(function* () {
      const fix = yield* createFixture()

      // First check: empty cache -> network call expected
      expect(fix.requests).toHaveLength(0)
      const ver1 = yield* fix.updater.latest()
      expect(ver1).toBe("3.5.0")
      expect(fix.requests).toHaveLength(1)

      // Cache file should now exist
      const cache = yield* fix.updater.readCache!()
      expect(cache).toBeDefined()
      expect(cache?.version).toBe("3.5.0")
      expect(cache?.checkedAt).toBeGreaterThan(0)

      // Second check: valid cache exists -> NO network call
      const ver2 = yield* fix.updater.latest()
      expect(ver2).toBe("3.5.0")
      expect(fix.requests).toHaveLength(1) // Still 1! Network bypassed.

      // check() also benefits from cache
      const checkRes = yield* fix.updater.check()
      expect(checkRes?.type).toBe("available")
      expect(fix.requests).toHaveLength(1) // Still 1!
    }),
  )

  it.live("2. Bypasses cache when force: true is specified", () =>
    Effect.gen(function* () {
      let currentServedVersion = "3.5.0"
      const fix = yield* createFixture({
        fetchHandler: async () =>
          Response.json({
            version: currentServedVersion,
            metadata: { package: "@orchestra/cli" },
          }),
      })

      // Populate cache with 3.5.0
      yield* fix.updater.latest()
      expect(fix.requests).toHaveLength(1)

      // Server publishes 3.6.0
      currentServedVersion = "3.6.0"

      // Normal call still gives cached 3.5.0
      const cached = yield* fix.updater.latest()
      expect(cached).toBe("3.5.0")
      expect(fix.requests).toHaveLength(1)

      // Force call fetches new version and updates cache
      const forced = yield* fix.updater.latest(undefined, { force: true })
      expect(forced).toBe("3.6.0")
      expect(fix.requests).toHaveLength(2)

      const updatedCache = yield* fix.updater.readCache!()
      expect(updatedCache?.version).toBe("3.6.0")
    }),
  )

  it.live("3. Re-fetches when cache TTL expires", () =>
    Effect.gen(function* () {
      const fix = yield* createFixture()

      // Manually seed expired cache entry
      yield* fix.updater.writeCache!({
        version: "3.4.0",
        checkedAt: Date.now() - (DEFAULT_UPDATE_CACHE_TTL_MS + 10_000),
      })

      // TTL is expired, so latest() must fetch fresh version
      const ver = yield* fix.updater.latest()
      expect(ver).toBe("3.5.0")
      expect(fix.requests).toHaveLength(1)

      // With long ttlMs, cache is hit
      const cached = yield* fix.updater.latest(undefined, { ttlMs: 60_000 })
      expect(cached).toBe("3.5.0")
      expect(fix.requests).toHaveLength(1)

      // With expired manual cache timestamp, next call re-fetches
      yield* fix.updater.writeCache!({
        version: "3.5.0",
        checkedAt: Date.now() - 5000,
      })
      const refreshed = yield* fix.updater.latest(undefined, { ttlMs: 1000 })
      expect(refreshed).toBe("3.5.0")
      expect(fix.requests).toHaveLength(2)
    }),
  )

  it.live("4. Returns offline status gracefully on network failure without crashing process", () =>
    Effect.gen(function* () {
      const fix = yield* createFixture({
        fetchHandler: async () => {
          throw new TypeError("Failed to fetch: net::ERR_INTERNET_DISCONNECTED")
        },
      })

      // When offline and no cache, check() returns offline status instead of crashing
      const checkResult = yield* fix.updater.check()
      expect(checkResult).toBeDefined()
      expect(checkResult?.type).toBe("offline")
      if (checkResult?.type === "offline") {
        expect(checkResult.cachedVersion).toBeUndefined()
        expect(checkResult.message).toContain("Failed to fetch")
      }
    }),
  )

  it.live("5. Returns offline status with previous cachedVersion when offline", () =>
    Effect.gen(function* () {
      const fix = yield* createFixture({
        fetchHandler: async () => {
          throw new Error("DNS resolution failure: getaddrinfo ENOTFOUND")
        },
      })

      // Seed previous cached version
      yield* fix.updater.writeCache!({
        version: "3.2.1",
        checkedAt: Date.now() - 1000,
      })

      // When forcing a check offline, it reports offline status along with last cachedVersion
      const checkResult = yield* fix.updater.check({ force: true })
      expect(checkResult).toBeDefined()
      expect(checkResult?.type).toBe("offline")
      if (checkResult?.type === "offline") {
        expect(checkResult.cachedVersion).toBe("3.2.1")
        expect(checkResult.message).toContain("DNS resolution failure")
      }
    }),
  )
})
