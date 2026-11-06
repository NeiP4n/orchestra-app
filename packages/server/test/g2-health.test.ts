import { expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Schema, Scope, Stream } from "effect"
import { Autoloop } from "@orchestra/core/autoloop/service"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const emptyConfigDir = path.join(os.tmpdir(), "orchestra-test-empty-config")
process.env.ORCHESTRA_CONFIG_DIR = emptyConfigDir
process.env.OPENCODE_CONFIG_DIR = emptyConfigDir
try {
  await fs.mkdir(emptyConfigDir, { recursive: true })
} catch {}

const MODEL_IDS = [
  "sonnet-5",
  "opus-5.5",
  "sonnet-5.5",
  "anymodel-coder",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-luna",
  "opus-5",
  "fable-5.1",
  "anymodel-reasoner",
  "anymodel-v4.1-flash",
]

const anymodelConfig = (settings: Record<string, unknown> = {}) =>
  JSON.stringify({
    providers: {
      anymodel: {
        package: "@orchestra/ai/providers/openai-compatible",
        settings: { baseURL: "https://anymodel.ghostly.su/v1", ...settings },
        models: Object.fromEntries(MODEL_IDS.map((id) => [id, {}])),
      },
    },
  })

const baseOptions = {
  app: { version: "test-version" },
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
} as const

type Handler = (request: Request) => Promise<Response>

const getJSON = (handler: Handler, url: string, headers?: Record<string, string>) =>
  Effect.promise(async () => {
    const response = await handler(new Request(`http://opencode.local${url}`, { headers }))
    return { status: response.status, body: await response.text() }
  }).pipe(
    Effect.map(({ status, body }) => ({ status, json: JSON.parse(body) as Record<string, unknown> })),
  )

const locationHeaders = (directory: string) => ({
  "x-opencode-directory": encodeURIComponent(directory),
})

const makeProjectDir = Effect.acquireDisposable(
  Effect.promise(() => tmpdir("opencode-g2-health-")),
).pipe(
  Effect.flatMap((config) =>
    Effect.promise(() => fs.mkdir(path.join(config.path, "project"), { recursive: true })).pipe(
      Effect.as(path.join(config.path, "project")),
    ),
  ),
)

const HealthBody = Schema.Struct({
  status: Schema.Literal("ok"),
  checks: Schema.Struct({
    database: Schema.Struct({ status: Schema.Literal("ok") }),
    bus: Schema.Struct({ status: Schema.Literal("ok") }),
    autoloop: Schema.Struct({ status: Schema.Literal("ok") }),
  }),
})

it.live("G2-6: /health reports ok on a healthy server and carries no secrets", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(baseOptions, { allowUnauthenticated: true })
    const { status, body } = yield* Effect.promise(async () => {
      const response = await handler(new Request("http://opencode.local/health"))
      return { status: response.status, body: await response.text() }
    })
    expect(status).toBe(200)
    expect(Schema.decodeUnknownSync(HealthBody)(JSON.parse(body)).status).toBe("ok")
    expect(body).not.toContain("apiKey")
    expect(body).not.toContain(".db")
    expect(body).not.toContain("ghostly")
  }).pipe(Effect.scoped),
  30_000,
)

it.live("G2-6: /health is 503 when the scheduler cannot answer", () =>
  Effect.gen(function* () {
    const failure = () =>
      Effect.fail(
        new Autoloop.ServiceFailure({ code: "unavailable", message: "scheduler is down" }),
      )
    const failingAutoloop = Autoloop.Service.of({
      execute: failure,
      getView: failure,
      subscribe: () => Stream.empty,
      heartbeat: failure,
      start: () => Effect.void as Effect.Effect<void, never, Scope.Scope>,
      stats: failure,
      configure: () => Effect.void,
    } as unknown as Autoloop.Interface)
    const handler = yield* ServerFetch.make(baseOptions, {
      allowUnauthenticated: true,
      overrides: [Autoloop.node.replace(Layer.succeed(Autoloop.Service, failingAutoloop))],
    })
    const { status, json } = yield* getJSON(handler, "/health")
    expect(status).toBe(503)
    expect(json._tag).toBe("ServiceUnavailableError")
    expect(json.service).toBe("autoloop")
    expect(String(json.message)).toContain("autoloop")
  }).pipe(Effect.scoped),
  30_000,
)

it.live("G2-6: /health needs no credentials while the API does", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(
      { ...baseOptions, password: "test-secret" },
      {},
    )
    const health = yield* Effect.promise(() => handler(new Request("http://opencode.local/health")))
    expect(health.status).toBe(200)
    yield* Effect.promise(() => health.text())
    const info = yield* Effect.promise(() => handler(new Request("http://opencode.local/api/info")))
    expect(info.status).toBe(401)
    yield* Effect.promise(() => info.text())
  }).pipe(Effect.scoped),
  30_000,
)

it.live("G2-6: /health is not location-scoped: a missing folder still answers 200", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(baseOptions, { allowUnauthenticated: true })
    const { status } = yield* getJSON(handler, "/health", {
      "x-opencode-directory": encodeURIComponent("/tmp/opencode-g2-health-no-such-dir"),
    })
    expect(status).toBe(200)
  }).pipe(Effect.scoped),
  30_000,
)

it.live("G2-6: a keyless provider is hidden from /api/model and /api/provider, and is never the default", () =>
  Effect.gen(function* () {
    const directory = yield* makeProjectDir
    const handler = yield* ServerFetch.make(
      { ...baseOptions, config: { project: false, content: anymodelConfig() } },
      { allowUnauthenticated: true },
    )
    const headers = locationHeaders(directory)
    // The provider list must agree with the model catalog on the FIRST call:
    // before the fix it answered [] here while /api/model already showed the
    // keyless provider's models (no Plugin.awaitActivation).
    const providersFirst = yield* getJSON(handler, "/api/provider", headers)
    expect(providersFirst.status).toBe(200)
    const providerIDs = (providersFirst.json.data as Array<Record<string, unknown>>).map((item) => item.id)
    expect(providerIDs).toContain("opencode")
    expect(providerIDs).not.toContain("anymodel")

    const models = yield* getJSON(handler, "/api/model", headers)
    expect(models.status).toBe(200)
    const modelProviders = (models.json.data as Array<Record<string, unknown>>).map((item) => item.providerID)
    expect(modelProviders).not.toContain("anymodel")
    expect(modelProviders.length).toBeGreaterThan(0)

    const def = yield* getJSON(handler, "/api/model/default", headers)
    expect(def.status).toBe(200)
    expect((def.json.data as Record<string, unknown> | undefined)?.providerID).not.toBe("anymodel")

    const providersAgain = yield* getJSON(handler, "/api/provider", headers)
    const providerIDsAgain = (providersAgain.json.data as Array<Record<string, unknown>>).map((item) => item.id)
    expect(providerIDsAgain).not.toContain("anymodel")
  }).pipe(Effect.scoped),
  30_000,
)

it.live("G2-6: a provider with its own key in settings is listed", () =>
  Effect.gen(function* () {
    const directory = yield* makeProjectDir
    const handler = yield* ServerFetch.make(
      {
        ...baseOptions,
        config: { project: false, content: anymodelConfig({ apiKey: "test-key-123" }) },
      },
      { allowUnauthenticated: true },
    )
    const headers = locationHeaders(directory)
    const providers = yield* getJSON(handler, "/api/provider", headers)
    const providerIDs = (providers.json.data as Array<Record<string, unknown>>).map((item) => item.id)
    expect(providerIDs).toContain("anymodel")
    const models = yield* getJSON(handler, "/api/model", headers)
    const anymodelModels = (models.json.data as Array<Record<string, unknown>>).filter(
      (item) => item.providerID === "anymodel",
    )
    expect(anymodelModels).toHaveLength(MODEL_IDS.length)
  }).pipe(Effect.scoped),
  30_000,
)

it.live("G2-6: a stored credential makes the keyless provider live without a config change", () =>
  Effect.gen(function* () {
    const directory = yield* makeProjectDir
    const handler = yield* ServerFetch.make(
      { ...baseOptions, config: { project: false, content: anymodelConfig() } },
      { allowUnauthenticated: true },
    )
    const headers = locationHeaders(directory)
    const before = yield* getJSON(handler, "/api/model", headers)
    expect(
      (before.json.data as Array<Record<string, unknown>>).some((item) => item.providerID === "anymodel"),
    ).toBe(false)
    const created = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/credential", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            integrationID: "anymodel",
            value: { type: "key", key: "test-key" },
          }),
        }),
      ),
    )
    expect(created.status).toBeLessThan(300)
    yield* Effect.promise(() => created.text())
    const after = yield* getJSON(handler, "/api/model", headers)
    expect(
      (after.json.data as Array<Record<string, unknown>>).filter((item) => item.providerID === "anymodel"),
    ).toHaveLength(MODEL_IDS.length)
    const providers = yield* getJSON(handler, "/api/provider", headers)
    expect(
      (providers.json.data as Array<Record<string, unknown>>).map((item) => item.id),
    ).toContain("anymodel")
  }).pipe(Effect.scoped),
  30_000,
)

it.live("G2-6: catalog reads answer 404 for a missing folder instead of a confident 200", () =>
  Effect.gen(function* () {
    const directory = path.join((yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-g2-health-")))).path, "project")
    const handler = yield* ServerFetch.make(baseOptions, { allowUnauthenticated: true })
    const headers = locationHeaders(directory)
    for (const endpoint of ["/api/model", "/api/model/default", "/api/provider", "/api/integration"]) {
      const { status, json } = yield* getJSON(handler, endpoint, headers)
      expect({ endpoint, status }).toEqual({ endpoint, status: 404 })
      expect(json._tag).toBe("LocationNotFoundError")
    }
  }).pipe(Effect.scoped),
  30_000,
)
