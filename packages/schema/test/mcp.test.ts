import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Mcp } from "../src/mcp.js"

describe("Mcp resources", () => {
  test("decodes resource catalogs and omits absent metadata", () => {
    const value = Schema.decodeUnknownSync(Mcp.ResourceCatalog)({
      resources: [{ server: "docs", name: "Readme", uri: "docs://readme" }],
      templates: [{ server: "docs", name: "File", uriTemplate: "docs://{path}" }],
    })

    expect(Schema.encodeSync(Mcp.ResourceCatalog)(value)).toEqual({
      resources: [{ server: "docs", name: "Readme", uri: "docs://readme" }],
      templates: [{ server: "docs", name: "File", uriTemplate: "docs://{path}" }],
    })
  })

  test("preserves text and base64 blob contents", () => {
    expect(
      Schema.decodeUnknownSync(Mcp.ResourceContent)({
        server: "docs",
        uri: "docs://readme",
        contents: [
          { type: "text", uri: "docs://readme", text: "hello", mimeType: "text/plain" },
          { type: "blob", uri: "docs://logo", blob: "aGVsbG8=", mimeType: "image/png" },
        ],
      }),
    ).toEqual({
      server: "docs",
      uri: "docs://readme",
      contents: [
        { type: "text", uri: "docs://readme", text: "hello", mimeType: "text/plain" },
        { type: "blob", uri: "docs://logo", blob: "aGVsbG8=", mimeType: "image/png" },
      ],
    })
  })

  test("supports streamable-http MCP server transport with streaming parameters", () => {
    const streamable = Schema.decodeUnknownSync(Mcp.ServerConfig)({
      type: "streamable-http",
      url: "https://mcp.example.com/stream",
      heartbeatInterval: 15_000,
      streamTimeout: 60_000,
      headers: { "x-custom-mcp": "true" },
    })

    expect(streamable.type).toBe("streamable-http")
    if (streamable.type === "streamable-http") {
      expect(streamable.url).toBe("https://mcp.example.com/stream")
      expect(streamable.heartbeatInterval).toBe(15_000)
      expect(streamable.streamTimeout).toBe(60_000)
      expect(streamable.headers).toEqual({ "x-custom-mcp": "true" })
    }

    const encoded = Schema.encodeSync(Mcp.ServerConfig)(streamable)
    expect(encoded).toEqual({
      type: "streamable-http",
      url: "https://mcp.example.com/stream",
      heartbeatInterval: 15_000,
      streamTimeout: 60_000,
      headers: { "x-custom-mcp": "true" },
    })
  })

  test("supports bidirectional stream parameters on remote MCP transport", () => {
    const remote = Schema.decodeUnknownSync(Mcp.ServerConfig)({
      type: "remote",
      url: "https://mcp.example.com/sse",
      heartbeatInterval: 10_000,
      streamTimeout: 30_000,
    })

    expect(remote.type).toBe("remote")
    if (remote.type === "remote") {
      expect(remote.heartbeatInterval).toBe(10_000)
      expect(remote.streamTimeout).toBe(30_000)
    }
  })
})


