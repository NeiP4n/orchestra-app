import { describe, expect, test } from "bun:test"
import { validateStreamableHttpEndpoint } from "../src/api.js"

describe("Streamable HTTP MCP validation", () => {
  test("accepts valid streamable-http endpoints", () => {
    const valid = validateStreamableHttpEndpoint({
      type: "streamable-http",
      url: "https://mcp.internal.net/stream",
      heartbeatInterval: 5_000,
      streamTimeout: 30_000,
    })
    expect(valid.valid).toBe(true)
    expect(valid.url).toBe("https://mcp.internal.net/stream")
    expect(valid.error).toBeUndefined()
  })

  test("rejects invalid URL protocols", () => {
    const invalidProto = validateStreamableHttpEndpoint({
      type: "streamable-http",
      url: "ftp://mcp.internal.net/stream",
    })
    expect(invalidProto.valid).toBe(false)
    expect(invalidProto.error).toContain("Invalid URL protocol")
  })

  test("rejects heartbeatInterval >= streamTimeout", () => {
    const invalidTimeout = validateStreamableHttpEndpoint({
      type: "streamable-http",
      url: "https://mcp.internal.net/stream",
      heartbeatInterval: 30_000,
      streamTimeout: 10_000,
    })
    expect(invalidTimeout.valid).toBe(false)
    expect(invalidTimeout.error).toContain("must be strictly less than streamTimeout")
  })

  test("rejects empty or malformed URL", () => {
    const emptyUrl = validateStreamableHttpEndpoint({
      type: "streamable-http",
      url: "   ",
    })
    expect(emptyUrl.valid).toBe(false)
    expect(emptyUrl.error).toContain("URL is required")

    const malformed = validateStreamableHttpEndpoint({
      type: "streamable-http",
      url: "not-a-valid-url",
    })
    expect(malformed.valid).toBe(false)
    expect(malformed.error).toContain("Invalid URL format")
  })
})
