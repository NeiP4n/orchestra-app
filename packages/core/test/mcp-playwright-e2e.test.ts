import path from "node:path"
import { describe, expect, test } from "bun:test"
import { ConfigMCP } from "@orchestra/schema/config/mcp"
import { Document, Info } from "@orchestra/schema/config"
import { Config } from "@orchestra/core/config"
import { ConfigMcpPlugin } from "@orchestra/core/config/plugin/mcp"
import { Credential } from "@orchestra/core/credential"
import { Bus } from "@orchestra/core/bus"
import { Form } from "@orchestra/core/form"
import { Integration } from "@orchestra/core/integration"
import { Environment } from "@orchestra/core/environment/index"
import { Location } from "@orchestra/core/location"
import { ManagedPolicy } from "@orchestra/core/managed-policy"
import { Database } from "@orchestra/core/database/database"
import { Session } from "@orchestra/core/session"
import { SessionStore } from "@orchestra/core/session/store"
import { KV } from "@orchestra/core/kv"
import { Project } from "@orchestra/core/project"
import { ProjectTable } from "@orchestra/core/project/sql"
import { SessionTable } from "@orchestra/core/session/sql"
import { State } from "@orchestra/core/state"
import { AbsolutePath } from "@orchestra/core/schema"
import { Mcp } from "@orchestra/core/mcp/index"
import { McpBudget } from "@orchestra/core/mcp/budget"
import { McpRatings } from "@orchestra/core/mcp/ratings"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { ID, type Payload } from "@orchestra/schema/event"
import { Effect, Layer, Schedule, Schema, Stream } from "effect"
import { hostEnvironmentLayer } from "./fixture/environment"
import { location } from "./fixture/location"
import { registerIntegrationPolicy } from "./fixture/policy"

// Live end-to-end test for the Playwright MCP server (block Б9): a real
// @playwright/mcp process is connected through the real MCP service, a
// browser tool is called with a session id, and the result lands in the
// session — the budget usage row counts the calls and the persistent
// rating records them. The page comes from a tiny HTTP server this test
// starts on 127.0.0.1, so the test needs no external network: the sandbox
// egress proxy is not reachable from Chrome, and example.com would fail
// there. It does need a Playwright Chromium install; it is skipped only
// when no browser binary is present, and the skip says so.
const chromiumDir = path.join(process.env.HOME ?? "~", ".cache", "ms-playwright")
const chromeExecutable = await import("node:fs/promises").then((fs) =>
  fs
    .readdir(chromiumDir)
    .then((entries) =>
      entries
        .filter((entry) => entry.startsWith("chromium-"))
        .map((entry) => path.join(chromiumDir, entry, "chrome-linux64", "chrome")),
    )
    .then(async (candidates) => {
      for (const candidate of candidates)
        if (await fs.stat(candidate).then(
          (info) => info.isFile(),
          () => false,
        ))
          return candidate
      return undefined
    })
    .catch(() => undefined),
)

const playwrightLayer = (seed: (database: Database.Interface) => Effect.Effect<void>) => {
  const directory = AbsolutePath.make(import.meta.dir)
  const unusedIntegration = () => Effect.die("unused integration service")
  // The layer owns the Database; the test effect outside it cannot yield
  // the service, so the layer captures the handle for the usage/rating
  // reads below (still inside the layer's scope when they run).
  let dbHandle: Database.Interface["db"] | undefined
  const db = () => {
    if (!dbHandle) throw new Error("MCP layer database not captured")
    return dbHandle
  }
  const config = new ConfigMCP.Local({
    type: "local",
    // The MCP server's bundled Playwright wants its own Chromium revision;
    // when only another revision is installed, point it at that binary
    // instead of failing on a missing executable.
    command: [
      process.execPath,
      "x",
      "-y",
      "@playwright/mcp@latest",
      "--browser",
      "chromium",
      // The sandbox egress proxy is not reachable from Chrome, and the MCP
      // server picks the proxy up from the environment; local pages must
      // bypass it or the navigation hangs on the tunnel.
      "--proxy-bypass",
      "localhost,127.0.0.1",
      ...(chromeExecutable ? ["--executable-path", chromeExecutable] : []),
    ],
    cwd: "fixture",
  })
  const layer = Layer.effectDiscard(
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const mcp = yield* Mcp.Service
      dbHandle = (yield* Database.Service).db
      yield* seed(yield* Database.Service)
      yield* State.batch(
        Effect.gen(function* () {
          yield* ConfigMcpPlugin.register(bus.subscribe())
          yield* registerIntegrationPolicy({ mcp, events: bus.subscribe() })
        }),
      )
    }),
  ).pipe(
    Layer.provideMerge(Mcp.layer()),
    Layer.provideMerge(Form.layer),
    Layer.provide(
      Layer.mergeAll(
        LayerNode.compile(LayerNode.group([Database.node, SessionStore.node, KV.node])),
        ManagedPolicy.layer,
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Document({
                  type: "document",
                  info: new Info({
                    mcp: new ConfigMCP.Info({ servers: { playwright: config } }),
                  }),
                }),
              ]),
            changes: () => Stream.never,
          }),
        ),
        Layer.succeed(Location.Service, Location.Service.of(location({ directory }))),
        Layer.mock(Bus.Service, {
          subscribe: () => Stream.never,
          publish: (definition, data) =>
            Effect.succeed({ id: ID.create(), type: definition.type, data } as Payload<typeof definition>),
        }),
        Layer.mock(Integration.Service, {
          revision: () => 0,
          connection: {
            active: unusedIntegration,
            resolve: unusedIntegration,
            key: unusedIntegration,
            external: unusedIntegration,
            activate: unusedIntegration,
            update: unusedIntegration,
            remove: unusedIntegration,
            status: unusedIntegration,
          },
          oauth: {
            connect: unusedIntegration,
            status: unusedIntegration,
            complete: unusedIntegration,
            cancel: unusedIntegration,
          },
          command: {
            connect: unusedIntegration,
            status: unusedIntegration,
            cancel: unusedIntegration,
          },
        }),
        Layer.mock(Credential.Service, {}),
        hostEnvironmentLayer,
      ),
    ),
  )
  return { layer, db }
}

const settled = (service: Mcp.Interface, name = "playwright") =>
  Effect.gen(function* () {
    const status = (yield* service.servers()).find((server) => server.name === name)?.status
    if (status?.status === "pending") return yield* Effect.fail(status)
    return status
  }).pipe(Effect.retry({ times: 600, schedule: Schedule.spaced("100 millis") }))

describe("MCP Playwright e2e (live)", () => {
  test("connect → call browser tools → result in the session", async () => {
    if (!chromeExecutable) {
      console.log("skipped: no Playwright Chromium in ~/.cache/ms-playwright (run `bun x playwright install chromium`)")
      return
    }
    const page = "<!doctype html><title>Example Domain</title><h1>Example Domain</h1><p>This domain is for use in illustrative examples.</p>"
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(page, { headers: { "content-type": "text/html" } }) })
    try {
      const sessionID = Session.ID.make("ses_playwright_e2e")
    const harness = playwrightLayer((database) =>
      Effect.gen(function* () {
        yield* database.db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            directory: AbsolutePath.make("/tmp"),
            slug: sessionID,
            version: "test",
            metadata: {
              "orchestra:mcp-limit": {
                servers: ["playwright"],
                maxCalls: 10,
                perServer: {},
                budgetEpoch: "epoch-playwright-e2e",
              },
            } as Schema.Json,
          })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Mcp.Service
          const status = yield* settled(service)
          expect(status).toEqual({ status: "connected" })
          const tools = yield* service.tools()
          expect(tools.map((tool) => tool.name)).toContain("browser_navigate")
          expect(tools.map((tool) => tool.name)).toContain("browser_snapshot")

          const navigated = yield* service.callTool({
            server: "playwright",
            name: "browser_navigate",
            args: { url: `http://127.0.0.1:${server.port}/` },
            sessionID,
            readOnly: true,
          })
          expect(navigated.isError).toBe(false)

          const snapshot = yield* service.callTool({
            server: "playwright",
            name: "browser_snapshot",
            args: {},
            sessionID,
            readOnly: true,
          })
          expect(snapshot.isError).toBe(false)
          const text = snapshot.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
          expect(text).toContain("Example Domain")

          // The result landed in the session: the budget row counted both
          // calls and their output, and the persistent rating recorded them.
          const usage = yield* McpBudget.readUsage(harness.db(), sessionID)
          expect(usage?.total).toBe(2)
          expect(usage?.tokens).toBeGreaterThan(0)
          const rating = yield* McpRatings.readRating(harness.db(), "playwright")
          expect(rating?.calls).toBe(2)
          expect(rating?.successes).toBe(2)
        }).pipe(Effect.provide(harness.layer)),
      ),
    )
    } finally {
      server.stop()
    }
  }, 180_000)
})
