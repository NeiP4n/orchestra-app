import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@orchestra/util/global"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live(
  "operator continuation HTTP defaults ON, validates input, and preserves OFF across a fresh server runtime",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("continuation-http-")))
      const global = Global.layerWith({
        data: path.join(tmp.path, "data"),
        cache: path.join(tmp.path, "cache"),
        config: path.join(tmp.path, "config"),
        state: path.join(tmp.path, "state"),
        tmp: path.join(tmp.path, "tmp"),
        bin: path.join(tmp.path, "bin"),
        log: path.join(tmp.path, "log"),
        repos: path.join(tmp.path, "repos"),
      })
      const make = () =>
        ServerFetch.make(
          {
            app: { version: "1.0.0" },
            database: { path: path.join(tmp.path, "continuation.db") },
            fs: { filewatcher: false },
            models: { fetch: false },
            config: { directory: tmp.path, project: false, content: "{}" },
          },
          { allowUnauthenticated: true, overrides: [Global.node.replace(global)] },
        )
      const request = (handler: Effect.Success<ReturnType<typeof make>>, method = "GET", enabled?: unknown) =>
        Effect.promise(async () => {
          const response = await handler(
            new Request("http://orchestra.local/api/config/continuation", {
              method,
              headers: { "content-type": "application/json" },
              body: method === "GET" ? undefined : JSON.stringify({ enabled }),
            }),
          )
          const text = await response.text()
          return { status: response.status, body: text ? JSON.parse(text) : undefined }
        })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handler = yield* make()
          expect(yield* request(handler)).toEqual({ status: 200, body: { enabled: true } })
          expect((yield* request(handler, "PUT", "false")).status).toBe(400)
          expect(yield* request(handler, "PUT", false)).toEqual({ status: 200, body: { enabled: false } })
          expect(yield* request(handler)).toEqual({ status: 200, body: { enabled: false } })
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handler = yield* make()
          expect(yield* request(handler)).toEqual({ status: 200, body: { enabled: false } })
          expect(yield* request(handler, "PUT", true)).toEqual({ status: 200, body: { enabled: true } })
        }),
      )
    }),
)
