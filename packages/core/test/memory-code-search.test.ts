import { describe, expect, test } from "bun:test"
import { MemoryCodeSearch } from "../src/memory/index"

describe("MemoryCodeSearch (xerj node)", () => {
  test("the default node URL is the loopback default port", () => {
    expect(MemoryCodeSearch.DEFAULT_NODE_URL).toBe("http://127.0.0.1:9200")
    expect(MemoryCodeSearch.loopbackProblem(MemoryCodeSearch.DEFAULT_NODE_URL)).toBeUndefined()
  })

  test("nodeUrlFromEnv prefers XERJ_URL and falls back to the default", () => {
    expect(MemoryCodeSearch.nodeUrlFromEnv({})).toBe("http://127.0.0.1:9200")
    expect(MemoryCodeSearch.nodeUrlFromEnv({ XERJ_URL: "  " })).toBe("http://127.0.0.1:9200")
    expect(MemoryCodeSearch.nodeUrlFromEnv({ XERJ_URL: "http://127.0.0.1:9217" })).toBe("http://127.0.0.1:9217")
  })

  test("the MCP command is a stdio server against the node, never --insecure", () => {
    expect(MemoryCodeSearch.mcpCommand()).toEqual([
      "xerj",
      "mcp",
      "--url",
      "http://127.0.0.1:9200",
      "--disable-feedback",
    ])
    expect(MemoryCodeSearch.mcpCommand("http://127.0.0.1:9217")).toContain("http://127.0.0.1:9217")
    expect(MemoryCodeSearch.mcpCommand().some((arg) => arg === "--insecure")).toBe(false)
  })

  test("loopbackProblem accepts loopback only", () => {
    expect(MemoryCodeSearch.loopbackProblem("http://127.0.0.1:9200")).toBeUndefined()
    expect(MemoryCodeSearch.loopbackProblem("http://[::1]:9200")).toBeUndefined()
    expect(MemoryCodeSearch.loopbackProblem("http://localhost:9200")).toBeUndefined()
    expect(MemoryCodeSearch.loopbackProblem("https://127.0.0.1:9200")).toBeUndefined()
    expect(MemoryCodeSearch.loopbackProblem("http://192.168.1.10:9200")).toContain("not a loopback node")
    expect(MemoryCodeSearch.loopbackProblem("http://xerj.internal:9200")).toContain("not a loopback node")
    expect(MemoryCodeSearch.loopbackProblem("file:///tmp/xerj")).toContain("not http(s)")
    expect(MemoryCodeSearch.loopbackProblem("not a url")).toContain("not a URL")
  })
})
