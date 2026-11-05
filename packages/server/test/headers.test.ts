import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { HttpServerRequest } from "effect/unstable/http"
import { it } from "../../core/test/lib/effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { Effect } from "effect"
import { AbsolutePath } from "@orchestra/core/schema"
import {
  LEGACY_LOCATION_DIRECTORY_HEADER,
  LOCATION_DIRECTORY_HEADER,
  requestRef,
} from "../src/location"
import { ServerFetch } from "../src/fetch"
import {
  LEGACY_PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER,
} from "@orchestra/protocol/groups/pty"

describe("HTTP headers unification (HTTP-001)", () => {
  test("requestRef resolves x-orchestra-directory canonically", () => {
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost:3000/api/session", {
        headers: { [LOCATION_DIRECTORY_HEADER]: encodeURIComponent("C:/test/canonical") },
      }),
    )
    expect(requestRef(request).directory).toBe(AbsolutePath.make("C:/test/canonical"))
  })

  test("requestRef transparently falls back to x-opencode-directory when x-orchestra-directory is absent", () => {
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost:3000/api/session", {
        headers: { [LEGACY_LOCATION_DIRECTORY_HEADER]: encodeURIComponent("C:/test/legacy") },
      }),
    )
    expect(requestRef(request).directory).toBe(AbsolutePath.make("C:/test/legacy"))
  })

  test("requestRef prioritizes canonical x-orchestra-directory over legacy x-opencode-directory", () => {
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost:3000/api/session", {
        headers: {
          [LOCATION_DIRECTORY_HEADER]: encodeURIComponent("C:/test/canonical"),
          [LEGACY_LOCATION_DIRECTORY_HEADER]: encodeURIComponent("C:/test/legacy"),
        },
      }),
    )
    expect(requestRef(request).directory).toBe(AbsolutePath.make("C:/test/canonical"))
  })
})

const options = {
  app: { version: "test-version" },
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
} as const

it.live("Server accepts both x-orchestra-directory and x-opencode-directory headers end-to-end", () =>
  Effect.gen(function* () {
    const config = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orchestra-headers-test-")))
    const directory = path.join(config.path, "project")
    yield* Effect.promise(() => fs.mkdir(directory))
    const handler = yield* ServerFetch.make({ ...options, config: { directory: config.path } })

    // 1. Create session using canonical x-orchestra-directory header
    const createdCanonical = yield* Effect.promise(() =>
      handler(
        new Request("http://orchestra.local/api/session", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCATION_DIRECTORY_HEADER]: encodeURIComponent(directory),
          },
          body: JSON.stringify({ location: { directory } }),
        }),
      ),
    )
    expect(createdCanonical.status).toBe(200)

    // 2. Query models using legacy x-opencode-directory header (fallback)
    const modelResponse = yield* Effect.promise(() =>
      handler(
        new Request("http://orchestra.local/api/model", {
          headers: { [LEGACY_LOCATION_DIRECTORY_HEADER]: encodeURIComponent(directory) },
        }),
      ),
    )
    expect(modelResponse.status).toBe(200)

    // 3. PTY connect-token accepts canonical x-orchestra-ticket
    const canonicalPty = yield* Effect.promise(() =>
      handler(
        new Request("http://orchestra.local/api/pty/pty_missing/connect-token", {
          method: "POST",
          headers: {
            [LOCATION_DIRECTORY_HEADER]: encodeURIComponent(directory),
            [PTY_CONNECT_TOKEN_HEADER]: "1",
          },
        }),
      ),
    )
    // 404 because ptyID is missing, but not 403 Forbidden: header was accepted
    expect(canonicalPty.status).toBe(404)

    // 4. PTY connect-token accepts legacy x-opencode-ticket
    const legacyPty = yield* Effect.promise(() =>
      handler(
        new Request("http://orchestra.local/api/pty/pty_missing/connect-token", {
          method: "POST",
          headers: {
            [LOCATION_DIRECTORY_HEADER]: encodeURIComponent(directory),
            [LEGACY_PTY_CONNECT_TOKEN_HEADER]: "1",
          },
        }),
      ),
    )
    // 404 because ptyID is missing, but not 403 Forbidden: header was accepted
    expect(legacyPty.status).toBe(404)

    // 5. Missing or invalid ticket header gives 403 Forbidden
    const rejectedPty = yield* Effect.promise(() =>
      handler(
        new Request("http://orchestra.local/api/pty/pty_missing/connect-token", {
          method: "POST",
          headers: {
            [LOCATION_DIRECTORY_HEADER]: encodeURIComponent(directory),
          },
        }),
      ),
    )
    expect(rejectedPty.status).toBe(403)
  }),
)
