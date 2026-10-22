import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Provider } from "@orchestra/core/provider"

describe("Provider", () => {
  test("loads bundled native provider entrypoints", async () => {
    const packages = [
      "@orchestra/ai/providers/baseten",
      "@orchestra/ai/providers/cerebras",
      "@orchestra/ai/providers/cloudflare-ai-gateway",
      "@orchestra/ai/providers/cloudflare-workers-ai",
      "@orchestra/ai/providers/cohere",
      "@orchestra/ai/providers/cohere/chat",
      "@orchestra/ai/providers/deepinfra",
      "@orchestra/ai/providers/deepseek",
      "@orchestra/ai/providers/fireworks",
      "@orchestra/ai/providers/google-vertex",
      "@orchestra/ai/providers/google-vertex/gemini",
      "@orchestra/ai/providers/google-vertex/chat",
      "@orchestra/ai/providers/google-vertex/responses",
      "@orchestra/ai/providers/google-vertex/messages",
      "@orchestra/ai/providers/groq",
      "@orchestra/ai/providers/mistral",
      "@orchestra/ai/providers/togetherai",
      "@orchestra/ai/providers/vercel-ai-gateway",
    ]

    for (const specifier of packages) {
      const loaded = await Effect.runPromise(Provider.loadPackage(specifier))
      expect(loaded.model).toBeFunction()
    }
  })

  test("passes flat settings to native packages without Core settings", () => {
    expect(
      Provider.nativeSettings({
        apiKey: "secret",
        reasoningEffort: "high",
        chunkTimeout: 1000,
        compaction: { type: "native" },
        transport: "websocket",
      }),
    ).toEqual({
      apiKey: "secret",
      reasoningEffort: "high",
    })
  })

  test("inherits shared and loose settings without provider-only policies", () => {
    expect(
      Provider.modelSettings({
        timeout: 60_000,
        chunkTimeout: 30_000,
        transport: "websocket",
        compaction: { type: "native" },
        reasoningEffort: "high",
      }),
    ).toEqual({
      compaction: { type: "native" },
      reasoningEffort: "high",
    })
  })
})
