import { PluginTestLayer } from "./fixture"
import { describe, expect, test } from "bun:test"
import { Effect, Logger, Schedule } from "effect"
import { Bus } from "@orchestra/core/bus"
import { Credential } from "@orchestra/core/credential"
import { Integration } from "@orchestra/core/integration"
import { Model } from "@orchestra/core/model"
import { Plugin } from "@orchestra/core/plugin"
import { PluginHost } from "@orchestra/core/plugin/host"
import { Provider } from "@orchestra/core/provider"
import { ProviderPlugins } from "@orchestra/core/plugin/provider"
import { KlinchPlugin } from "@orchestra/core/plugin/provider/klinch"
import { discoveryTimeout, retryable, singleFlight } from "@orchestra/core/plugin/provider/klinch-discovery"
import { KLINCH_BASE_URL } from "@orchestra/core/session/runner/error-taxonomy"
import { testEffect } from "../lib/effect"

const it = testEffect(PluginTestLayer)
const providerID = Provider.ID.make("klinch")
const integrationID = Integration.ID.make("klinch")

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* KlinchPlugin.effect(host)
})

const createKey = Effect.fn(function* () {
  const credentials = yield* Credential.Service
  return yield* credentials.create({
    integrationID,
    // A fake key: only the presence of a stored key matters here, never a
    // real one. Live klinch calls are impossible without the user's key.
    value: Credential.Key.make({ type: "key", key: "test-klinch-key" }),
  })
})

// Discovery calls the real network (the base URL is a fixed https URL, so no
// local server can stand in for it); the stub below is the only way to test
// it without one. Scoped to the single plugin run and restored right after.
const withStubbedFetch = <A, E, R>(status: number, body: unknown, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.klinch.cloud/v1/models")
      expect(init?.method).toBe("GET")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-klinch-key")
      return Response.json(body, { status })
    }) as unknown as typeof fetch
    try {
      return yield* effect
    } finally {
      globalThis.fetch = originalFetch
    }
  })

describe("KlinchPlugin (arch3 №4)", () => {
  test("is registered alongside the other provider plugins", () => {
    expect(ProviderPlugins.map((item) => item.id)).toContain("orchestra.provider.klinch")
  })

  it.effect("seeds the provider but never advertises it without a key", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      yield* addPlugin()

      const snapshot = yield* providers.snapshot()
      const record = snapshot.records.get(providerID)
      expect(record?.provider.package).toBe("@orchestra/ai/providers/openai-compatible")
      expect(record?.provider.settings?.baseURL).toBe(KLINCH_BASE_URL)
      expect(record?.provider.integrationID).toBe(integrationID)
      expect(record?.models.size).toBe(0)
      // Registered, but with no stored key it is not available: nothing
      // offers klinch as a working provider, and startup never waits on it.
      expect(snapshot.providers.some((provider) => provider.id === providerID)).toBe(false)
    }),
  )

  test("seeded API origin matches the service's documented OpenAI endpoint", () => {
    expect(KLINCH_BASE_URL).toBe("https://api.klinch.cloud/v1")
  })

  it.effect("discovers models from /models once a key is stored", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      yield* createKey()
      yield* withStubbedFetch(
        200,
        { data: [{ id: "klinch-chat" }, { id: "klinch-code", name: "Klinch Code" }] },
        addPlugin(),
      )

      const snapshot = yield* providers.snapshot()
      const record = snapshot.records.get(providerID)
      expect([...(record?.models.values() ?? [])].map((model) => model.id)).toEqual([
        Model.ID.make("klinch-chat"),
        Model.ID.make("klinch-code"),
      ])
      expect(record?.models.get(Model.ID.make("klinch-code"))?.name).toBe("Klinch Code")
      expect(snapshot.providers.some((provider) => provider.id === providerID)).toBe(true)
    }),
  )

  it.effect("a rejected key publishes no models", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      yield* createKey()
      yield* withStubbedFetch(401, { error: { message: "invalid key" } }, addPlugin())

      const snapshot = yield* providers.snapshot()
      expect(snapshot.records.get(providerID)?.models.size).toBe(0)
    }),
  )
})

describe("Klinch discovery diagnostics", () => {
  for (const outcome of ["no-connection", "success", "empty", "auth", "http"] as const) {
    it.effect(`reports safe ${outcome} outcome without endpoint messages or credentials`, () =>
      Effect.gen(function* () {
        if (outcome !== "no-connection") yield* createKey()
        const logs: unknown[] = []
        const run = addPlugin().pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => logs.push(entry.message))])),
        )
        yield* outcome === "no-connection"
          ? run
          : withStubbedFetch(
              outcome === "auth" ? 401 : outcome === "http" ? 503 : 200,
              outcome === "auth" || outcome === "http"
                ? { error: { message: "RAW_SECRET_CANARY" } }
                : { data: outcome === "empty" ? [] : [{ id: "test-model" }] },
              run,
            )
        const text = JSON.stringify(logs)
        expect(text).toContain("Klinch model discovery")
        expect(text).toContain("startup")
        expect(text).toContain(
          outcome === "no-connection"
            ? "not-attempted"
            : outcome === "auth" || outcome === "http"
              ? "failed"
              : "succeeded",
        )
        expect(text).not.toContain("test-klinch-key")
        expect(text).not.toContain("RAW_SECRET_CANARY")
      }),
    )
  }
})

it.live("new connection after plugin startup reaches Model.available without restart", () =>
  withStubbedFetch(
    200,
    { data: [{ id: "gpt-5.4-mini" }] },
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const models = yield* Model.Service
      const bus = yield* Bus.Service
      const providers = yield* Provider.Service
      yield* plugins.activate([
        {
          ...KlinchPlugin,
          revision: "test-startup",
          effect: (ctx) =>
            KlinchPlugin.effect(ctx).pipe(
              Effect.provideService(Bus.Service, bus),
              Effect.provideService(Provider.Service, providers),
            ),
        },
      ])
      expect((yield* models.available()).filter((m) => m.providerID === providerID)).toHaveLength(0)
      yield* createKey()
      yield* models.available().pipe(
        Effect.filterOrFail((items) => items.some((m) => m.providerID === providerID && m.id === "gpt-5.4-mini")),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
    }),
  ),
)

test("Klinch discovery budgets and retry taxonomy are bounded", () => {
  expect(discoveryTimeout("")).toBe(60000)
  expect(discoveryTimeout("90000")).toBe(90000)
  expect(discoveryTimeout("120001")).toBe(60000)
  expect(discoveryTimeout("NaN")).toBe(60000)
  expect(discoveryTimeout("999")).toBe(60000)
  for (const error of [
    { kind: "timeout" },
    { kind: "network" },
    { kind: "http", status: 503 },
    { kind: "http", status: 429 },
  ])
    expect(retryable(error)).toBe(true)
  for (const error of [
    { kind: "auth", status: 401 },
    { kind: "unsupported" },
    { kind: "http", status: 400 },
    { kind: "invalid-url" },
  ])
    expect(retryable(error)).toBe(false)
})

test("concurrent locations share only an in-flight discovery and failures are not cached", async () => {
  let calls = 0
  const run = async () => {
    calls++
    return { ok: false }
  }
  const a = singleFlight("fake-connection", run)
  const b = singleFlight("fake-connection", run)
  expect(a.shared).toBe(false)
  expect(b.shared).toBe(true)
  expect(await a.result).toEqual(await b.result)
  expect(calls).toBe(1)
  await singleFlight("fake-connection", run).result
  expect(calls).toBe(2)
})

for (const failure of ["timeout", "http"] as const)
  it.live(`transient ${failure} startup failure retries without a credential event and exposes models`, () =>
    Effect.gen(function* () {
      yield* createKey()
      let calls = 0
      const original = globalThis.fetch
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.klinch.cloud/v1/models")
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-klinch-key")
        if (++calls === 1) {
          if (failure === "timeout") throw new DOMException("PRIVATE_CANARY", "TimeoutError")
          return Response.json({ error: "PRIVATE_CANARY" }, { status: 503 })
        }
        return Response.json({ data: [{ id: "gpt-5.4-mini" }] })
      }) as unknown as typeof fetch
      try {
        yield* addPlugin()
        const models = yield* Model.Service
        yield* models.available().pipe(
          Effect.filterOrFail((items) => items.some((m) => m.providerID === providerID && m.id === "gpt-5.4-mini")),
          Effect.retry(Schedule.spaced("10 millis")),
          Effect.timeout("3 seconds"),
        )
        expect(calls).toBe(2)
      } finally {
        globalThis.fetch = original
      }
    }),
  )

it.live("two concurrent Klinch plugin activations issue one catalog GET", () =>
  Effect.gen(function* () {
    yield* createKey()
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 20))
      return Response.json({ data: [{ id: "gpt-5.4-mini" }] })
    }) as unknown as typeof fetch
    try {
      yield* Effect.all([addPlugin(), addPlugin()], { concurrency: 2 })
      expect(calls).toBe(1)
      expect(
        (yield* (yield* Model.Service).available()).some((m) => m.providerID === providerID && m.id === "gpt-5.4-mini"),
      ).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  }),
)
