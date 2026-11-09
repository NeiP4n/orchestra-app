import { describe, expect, test } from "bun:test"
import { browserRouteRefusal } from "../src/tool/plugin/orchestra"

describe("browser tasks go to the BrowserAgent", () => {
  test("page work sent to another role is refused with the way to the BrowserAgent", () => {
    for (const text of ["Open https://muse.ai and click Sign up", "зайди на сайт и заполни форму", "log in to the site and scroll"])
      expect(browserRouteRefusal("developer", text)).toContain("BrowserAgent")
  })
  test("the BrowserAgent itself and ordinary work are not refused", () => {
    expect(browserRouteRefusal("browser-agent", "Open https://muse.ai")).toBeUndefined()
    expect(browserRouteRefusal("developer", "Refactor the parser and run the tests")).toBeUndefined()
    expect(browserRouteRefusal("developer", undefined)).toBeUndefined()
  })
})

import { McpCatalog } from "../src/mcp/catalog"
describe("no browser automation outside the browser tool", () => {
  test("playwright and chrome-devtools are refused unless the operator sets their flag", () => {
    expect(McpCatalog.separateBrowserDenial("playwright", {})).toContain("browser tool")
    expect(McpCatalog.separateBrowserDenial("chrome-devtools", {})).toContain("browser tool")
    expect(McpCatalog.separateBrowserDenial("playwright", { ORCHESTRA_MCP_PLAYWRIGHT: "1" })).toBeUndefined()
    expect(McpCatalog.separateBrowserDenial("context7", {})).toBeUndefined()
  })
  test("the Playwright entry never points at Edge", () => {
    const entry = McpCatalog.all.find((item) => item.id === "playwright")!
    expect(JSON.stringify(entry.config)).not.toMatch(/edge/i)
  })
})

describe("MCP switch", () => {
  test("MCP is off unless ORCHESTRA_MCP=1", () => {
    expect(McpCatalog.mcpEnabled({})).toBe(false)
    expect(McpCatalog.mcpEnabled({ ORCHESTRA_MCP: "0" })).toBe(false)
    expect(McpCatalog.mcpEnabled({ ORCHESTRA_MCP: "1" })).toBe(true)
  })
})
