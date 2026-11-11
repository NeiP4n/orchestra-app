import { describe, expect, test } from "bun:test"
import { all, forPlatform } from "../src/mcp/catalog"

describe("useful MCP registry entries", () => {
  test("contains the curated developer tool set", () => {
    const ids = new Set(all.map((entry) => entry.id))

    for (const id of ["context7", "serena", "rea-anything", "deepwiki", "sentry"]) {
      expect(ids.has(id)).toBe(true)
    }
    for (const id of ["playwright", "chrome-devtools", "agent-desktop", "github"]) expect(ids.has(id)).toBe(false)
  })

  test("no platform-restricted entries ship: the catalog lists the same set on every platform", () => {
    const everywhere = all.map((entry) => entry.id)
    expect(forPlatform("win32").map((entry) => entry.id)).toEqual(everywhere)
    expect(forPlatform("linux").map((entry) => entry.id)).toEqual(everywhere)
    expect(forPlatform("darwin").map((entry) => entry.id)).toEqual(everywhere)
  })

  test("entries that exit without a secret say which environment variable they need", () => {
    const requires = Object.fromEntries(all.map((entry) => [entry.id, entry.requires]))

    expect(requires["sentry"]).toEqual(["SENTRY_ACCESS_TOKEN"])
    expect(requires["context7"]).toBeUndefined()
    expect(requires["serena"]).toBeUndefined()
  })
})
