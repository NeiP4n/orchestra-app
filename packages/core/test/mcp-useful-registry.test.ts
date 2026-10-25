import { describe, expect, test } from "bun:test"
import { all, forPlatform } from "../src/mcp/catalog"

describe("useful MCP registry entries", () => {
  test("contains the curated developer tool set", () => {
    const ids = new Set(all.map((entry) => entry.id))

    for (const id of [
      "context7",
      "rea-anything",
      "playwright",
      "chrome-devtools",
      "filesystem",
      "git",
      "github",
      "deepwiki",
      "fetch",
      "memory",
      "sequential-thinking",
      "brave-search",
      "sentry",
      "time",
      "mcp-docs",
    ]) {
      expect(ids.has(id)).toBe(true)
    }
  })

  test("Windows-only entries stay hidden on non-Windows platforms", () => {
    expect(forPlatform("win32").some((entry) => entry.id === "windows")).toBe(true)
    expect(forPlatform("linux").some((entry) => entry.id === "windows")).toBe(false)
    expect(forPlatform("darwin").some((entry) => entry.id === "windows")).toBe(false)
  })

  test("entries that exit without a secret say which environment variable they need", () => {
    const requires = Object.fromEntries(all.map((entry) => [entry.id, entry.requires]))

    expect(requires["brave-search"]).toEqual(["BRAVE_API_KEY"])
    expect(requires["sentry"]).toEqual(["SENTRY_ACCESS_TOKEN"])
    expect(requires["context7"]).toBeUndefined()
    expect(requires["memory"]).toBeUndefined()
  })
})
