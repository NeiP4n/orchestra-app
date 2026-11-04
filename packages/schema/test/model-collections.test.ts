import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigModel } from "../src/config/model.js"

const decode = Schema.decodeUnknownSync(ConfigModel.Collections)

describe("Config.ModelCollections", () => {
  test("decodes a valid collections document", () => {
    const value = decode([
      { id: "work", name: "Work", enabled: true, models: ["openai/gpt-x", "custom-ep/llama-3"] },
      { id: "off", name: "Off", enabled: false, models: [] },
    ])
    expect(value).toHaveLength(2)
    expect(value[0].models[1]).toBe("custom-ep/llama-3")
  })

  test("rejects malformed collections", () => {
    // uppercase id violates the slug pattern
    expect(() => decode([{ id: "Work", name: "W", enabled: true, models: [] }])).toThrow()
    // refs must be provider/model
    expect(() => decode([{ id: "w", name: "W", enabled: true, models: ["no-slash"] }])).toThrow()
    // enabled is required — persistence must be explicit, not defaulted silently
    expect(() => decode([{ id: "w", name: "W", models: [] }])).toThrow()
  })
})
