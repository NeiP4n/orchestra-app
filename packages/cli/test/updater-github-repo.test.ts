import { describe, expect, spyOn } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { Global } from "@orchestra/util/global"
import { AppProcess } from "@orchestra/util/process"
import { EffectFlock } from "@orchestra/util/effect-flock"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import path from "node:path"
import { Updater } from "../src/services/updater"
import { testEffect } from "../../core/test/lib/effect"

const it = testEffect(NodeServices.layer)

// T3-12: ORCHESTRA_GITHUB_REPO is interpolated into the GitHub API path, so a
// malformed value must fail before any fetch. The fixture never sets
// ORCHESTRA_UPDATE_URL, so latest() takes the GitHub fallback path.
function createFixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "orchestra-updater-github-repo-" })
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
    const previousRepo = process.env.ORCHESTRA_GITHUB_REPO
    delete process.env.ORCHESTRA_UPDATE_URL

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previousUpdateUrl === undefined) delete process.env.ORCHESTRA_UPDATE_URL
        else process.env.ORCHESTRA_UPDATE_URL = previousUpdateUrl
        if (previousRepo === undefined) delete process.env.ORCHESTRA_GITHUB_REPO
        else process.env.ORCHESTRA_GITHUB_REPO = previousRepo
      }),
    )

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async (input: string | URL | Request) => {
              const url = input instanceof Request ? input.url : input.toString()
              requests.push(url)
              return Response.json({ tag_name: "v1.2.3" })
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

    return { updater, requests }
  })
}

describe("ORCHESTRA_GITHUB_REPO validation (T3-12)", () => {
  it.live("rejects malformed repo values before any fetch", () =>
    Effect.gen(function* () {
      const fix = yield* createFixture()
      for (const repo of ["../../etc/passwd", "owner/repo extra", "owner", "owner/repo/sub", "own er/repo", "/repo", "owner/"]) {
        process.env.ORCHESTRA_GITHUB_REPO = repo
        const error = yield* fix.updater.latest(undefined, { force: true }).pipe(Effect.flip)
        expect(String((error as Error).message)).toContain("ORCHESTRA_GITHUB_REPO")
      }
      expect(fix.requests).toEqual([])
    }),
  )

  it.live("fetches the latest release for a valid owner/repository", () =>
    Effect.gen(function* () {
      const fix = yield* createFixture()
      process.env.ORCHESTRA_GITHUB_REPO = "NeiP4n/orchestra-app"
      const version = yield* fix.updater.latest(undefined, { force: true })
      expect(version).toBe("1.2.3")
      expect(fix.requests).toEqual(["https://api.github.com/repos/NeiP4n/orchestra-app/releases/latest"])
    }),
  )
})
