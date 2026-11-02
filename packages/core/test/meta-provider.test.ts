import { describe, expect, test } from "bun:test"
import { metaSettings } from "@orchestra/core/plugin/provider/meta"

describe("Meta provider settings", () => {
  test("defaults to the Meta Model API base URL and is unconfigured without a key", () => {
    const settings = metaSettings([], undefined)

    expect(settings.baseURL).toBe("https://api.meta.ai/v1")
    expect(settings.configured).toBe(false)
  })

  test("connector key wins over the environment, META_API_KEY wins over MODEL_API_KEY", () => {
    const savedMeta = process.env.META_API_KEY
    const savedModel = process.env.MODEL_API_KEY

    try {
      process.env.META_API_KEY = "meta-env"
      process.env.MODEL_API_KEY = "model-env"

      expect(metaSettings([], undefined).apiKey).toBe("meta-env")
      expect(metaSettings([], "connected-key").apiKey).toBe("connected-key")

      delete process.env.META_API_KEY

      expect(metaSettings([], undefined).apiKey).toBe("model-env")
    } finally {
      if (savedMeta === undefined) delete process.env.META_API_KEY
      else process.env.META_API_KEY = savedMeta
      if (savedModel === undefined) delete process.env.MODEL_API_KEY
      else process.env.MODEL_API_KEY = savedModel
    }
  })
})
