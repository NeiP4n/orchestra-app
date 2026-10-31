import { describe, expect, test } from "bun:test"
import { discoverModels, polzaSettings } from "@orchestra/core/plugin/provider/polza"

describe("Polza catalog", () => {
  test("maps a chat model and converts its ruble prices to the shared USD ledger", () => {
    const [model] = discoverModels(
      {
        id: "anthropic/claude-sonnet-5",
        name: "Claude Sonnet 5",
        type: "chat",
        endpoints: ["/api/v1/chat/completions"],
        context_length: 200_000,
        max_completion_tokens: 64_000,
        architecture: { input_modalities: ["text", "image"] },
        top_provider: {
          supported_parameters: ["tools", "reasoning"],
          pricing: {
            currency: "RUB",
            prompt_per_million: "240",
            completion_per_million: "1200",
            input_cache_read_per_million: "24",
          },
        },
      },
      80,
    )

    expect(model).toBeDefined()
    expect(model!.id).toBe("anthropic/claude-sonnet-5")
    expect(model!.tools).toBe(true)
    expect(model!.vision).toBe(true)
    expect(model!.context).toBe(200_000)
    expect(model!.output).toBe(64_000)
    expect(Number(model!.cost[0]!.input)).toBe(3)
    expect(Number(model!.cost[0]!.output)).toBe(15)
    expect(Number(model!.cost[0]!.cache.read)).toBe(0.3)
  })

  test("drops models the chat protocol cannot run", () => {
    expect(
      discoverModels(
        { id: "sunu/music", type: "music", endpoints: ["/api/v1/audio/generations"] },
        80,
      ),
    ).toEqual([])
  })

  test("reads the key, endpoint and rate from the provider settings", () => {
    const settings = polzaSettings([
      {
        type: "document",
        info: {
          providers: {
            polza: {
              settings: { apiKey: "test-key", baseURL: "https://polza.ai/api/v1/", exchangeRate: 92 },
            },
          },
        },
      },
    ] as never)
    expect(settings.apiKey).toBe("test-key")
    expect(settings.baseURL).toBe("https://polza.ai/api/v1")
    expect(settings.exchangeRate).toBe(92)
  })
})
