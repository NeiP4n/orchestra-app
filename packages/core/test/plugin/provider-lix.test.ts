import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@orchestra/core/credential"
import { Integration } from "@orchestra/core/integration"
import { Model } from "@orchestra/core/model"
import { Plugin } from "@orchestra/core/plugin"
import { PluginHost } from "@orchestra/core/plugin/host"
import { Provider } from "@orchestra/core/provider"
import { ProviderPlugins } from "@orchestra/core/plugin/provider"
import { LixPlugin } from "@orchestra/core/plugin/provider/lix"
import { LIX_BASE_URL } from "@orchestra/core/session/runner/error-taxonomy"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = Provider.ID.make("lix")
const integrationID = Integration.ID.make("lix")

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* LixPlugin.effect(host)
})

const createKey = Effect.fn(function* () {
  const credentials = yield* Credential.Service
  return yield* credentials.create({
    integrationID,
    // A fake key: only the presence of a stored key matters here, never a
    // real one. Live lix calls are impossible without the user's key.
    value: Credential.Key.make({ type: "key", key: "test-lix-key" }),
  })
})

// Discovery calls the real network (the base URL is a fixed https URL, so no
// local server can stand in for it); the stub below is the only way to test
// it without one. Scoped to the single plugin run and restored right after.
const withStubbedFetch = <A, E, R>(status: number, body: unknown, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json(body, { status })) as unknown as typeof fetch
    try {
      return yield* effect
    } finally {
      globalThis.fetch = originalFetch
    }
  })

describe("LixPlugin (G2-14)", () => {
  test("is registered alongside the other provider plugins", () => {
    expect(ProviderPlugins.map((item) => item.id)).toContain("orchestra.provider.lix")
  })

  it.effect("seeds the provider but never advertises it without a key", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      yield* addPlugin()

      const snapshot = yield* providers.snapshot()
      const record = snapshot.records.get(providerID)
      expect(record?.provider.package).toBe("@orchestra/ai/providers/openai-compatible")
      expect(record?.provider.settings?.baseURL).toBe(LIX_BASE_URL)
      expect(record?.provider.integrationID).toBe(integrationID)
      expect(record?.models.size).toBe(0)
      // Registered, but with no stored key it is not available: nothing
      // offers lix as a working provider, and startup never waits on it.
      expect(snapshot.providers.some((provider) => provider.id === providerID)).toBe(false)
    }),
  )

  it.effect("discovers models from /models once a key is stored", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      yield* createKey()
      yield* withStubbedFetch(
        200,
        { data: [{ id: "lix-chat" }, { id: "lix-code", name: "Lix Code" }] },
        addPlugin(),
      )

      const snapshot = yield* providers.snapshot()
      const record = snapshot.records.get(providerID)
      expect([...(record?.models.values() ?? [])].map((model) => model.id)).toEqual([
        Model.ID.make("lix-chat"),
        Model.ID.make("lix-code"),
      ])
      expect(record?.models.get(Model.ID.make("lix-code"))?.name).toBe("Lix Code")
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
