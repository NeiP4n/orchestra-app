import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { ServerFetch } from "../src/fetch"
import { rewriteLegacyApiPath } from "../src/alias"
import { PTY_CONNECT_TOKEN_HEADER } from "@orchestra/protocol/groups/pty"

describe("Route and endpoint aliases (URL-001)", () => {
  test("rewriteLegacyApiPath translates legacy /api/opencode/* to canonical routes", () => {
    expect(rewriteLegacyApiPath("/api/opencode")).toBe("/api/orchestra")
    expect(rewriteLegacyApiPath("/api/opencode/")).toBe("/api/orchestra")
    expect(rewriteLegacyApiPath("/api/opencode/project")).toBe("/api/orchestra/project")
    expect(rewriteLegacyApiPath("/api/opencode/project/prj_123/main")).toBe("/api/orchestra/project/prj_123/main")
    expect(rewriteLegacyApiPath("/api/opencode/template")).toBe("/api/orchestra/template")
    expect(rewriteLegacyApiPath("/api/opencode/role")).toBe("/api/orchestra/role")
    expect(rewriteLegacyApiPath("/api/opencode/group")).toBe("/api/orchestra/group")
    expect(rewriteLegacyApiPath("/api/opencode/group/OpenCodePP/chat")).toBe("/api/orchestra/group/OpenCodePP/chat")
    expect(rewriteLegacyApiPath("/api/opencode/group/OpenCodePP/link")).toBe("/api/orchestra/group/OpenCodePP/link")
    expect(rewriteLegacyApiPath("/api/opencode/link")).toBe("/api/orchestra/link")
    expect(rewriteLegacyApiPath("/api/opencode/owner/ses_123")).toBe("/api/orchestra/owner/ses_123")
    expect(rewriteLegacyApiPath("/api/opencode/access/ses_123")).toBe("/api/orchestra/access/ses_123")
    expect(rewriteLegacyApiPath("/api/opencode/category/ses_123")).toBe("/api/orchestra/category/ses_123")
  })

  test("rewriteLegacyApiPath translates legacy WebSocket and service routes", () => {
    expect(rewriteLegacyApiPath("/api/opencode/pty/pty_123/connect?ticket=1")).toBe(
      "/api/pty/pty_123/connect?ticket=1",
    )
    expect(rewriteLegacyApiPath("/api/opencode/pty/pty_123/connect-token")).toBe(
      "/api/pty/pty_123/connect-token",
    )
    expect(
      rewriteLegacyApiPath("/api/opencode/experimental/persistent-pty/pty_123/connect?ticket=1"),
    ).toBe("/api/experimental/persistent-pty/pty_123/connect?ticket=1")
    expect(rewriteLegacyApiPath("/api/opencode/event")).toBe("/api/event")
  })

  test("rewriteLegacyApiPath preserves already canonical /api/orchestra/* paths", () => {
    expect(rewriteLegacyApiPath("/api/orchestra/project")).toBe("/api/orchestra/project")
    expect(rewriteLegacyApiPath("/api/orchestra/group")).toBe("/api/orchestra/group")
    expect(rewriteLegacyApiPath("/api/pty/pty_123/connect")).toBe("/api/pty/pty_123/connect")
  })
})

const options = {
  app: { version: "test-version" },
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
} as const

it.live("Server handles legacy /api/opencode/* aliases end-to-end", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orchestra-url-alias-")))
    const directory = path.join(tmp.path, "repo")
    yield* Effect.promise(() => mkdir(directory, { recursive: true }))

    const handler = yield* ServerFetch.make({
      ...options,
      config: { directory: tmp.path, project: false, content: "{}" },
    })

    const call = (route: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://orchestra.local${route}`, {
            method,
            headers: { "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        const text = await response.text()
        return {
          status: response.status,
          body: text ? JSON.parse(text) : undefined,
        }
      })

    // 1. Create project via legacy /api/opencode/project alias
    const createProject = yield* call("/api/opencode/project", "POST", {
      name: "LegacyProject",
      directory,
    })
    expect(createProject.status).toBe(200)
    expect(createProject.body).toMatchObject({ name: "LegacyProject", directory })

    // 2. Read projects via legacy /api/opencode/project alias
    const listProjects = yield* call("/api/opencode/project", "GET")
    expect(listProjects.status).toBe(200)
    expect(listProjects.body.map((item: { name: string }) => item.name)).toContain("LegacyProject")

    // 3. Read templates via legacy /api/opencode/template alias
    const listTemplates = yield* call("/api/opencode/template", "GET")
    expect(listTemplates.status).toBe(200)
    expect(Array.isArray(listTemplates.body)).toBe(true)

    // 4. Read roles via legacy /api/opencode/role alias
    const listRoles = yield* call("/api/opencode/role", "GET")
    expect(listRoles.status).toBe(200)
    expect(Array.isArray(listRoles.body)).toBe(true)

    // 5. Read groups via legacy /api/opencode/group alias
    const listGroups = yield* call("/api/opencode/group", "GET")
    expect(listGroups.status).toBe(200)
    expect(Array.isArray(listGroups.body)).toBe(true)

    // 6. PTY connect-token via legacy /api/opencode/pty alias reaches PTY handler
    const ptyToken = yield* call(
      "/api/opencode/pty/pty_missing/connect-token",
      "POST",
      undefined,
      {
        [PTY_CONNECT_TOKEN_HEADER]: "1",
        "x-orchestra-directory": encodeURIComponent(directory),
      },
    )
    // 404 because ptyID is missing in service, proving route was aliased to pty handler (not RouteNotFound)
    expect(ptyToken.status).toBe(404)
  }),
)
