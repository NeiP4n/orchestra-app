import { describe, expect, test } from "bun:test"
import { BROWSER_ROUTE_REFUSAL, browserRouteRefusal, browserSessionTitle } from "../src/tool/plugin/orchestra"

describe("browser tasks go to the BrowserAgent", () => {
  test("page work sent to another role is refused with the way to the BrowserAgent", () => {
    for (const text of [
      "Open https://muse.ai and click Sign up",
      "зайди на сайт и заполни форму",
      "log in to the site and scroll",
    ])
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
  test("no built-in launcher can recreate a separate Playwright or DevTools browser", () => {
    for (const id of ["playwright", "chrome-devtools"])
      expect(McpCatalog.all.find((item) => item.id === id)).toBeUndefined()
  })
})

describe("MCP switch", () => {
  test("MCP is off unless ORCHESTRA_MCP=1", () => {
    expect(McpCatalog.mcpEnabled({})).toBe(false)
    expect(McpCatalog.mcpEnabled({ ORCHESTRA_MCP: "0" })).toBe(false)
    expect(McpCatalog.mcpEnabled({ ORCHESTRA_MCP: "1" })).toBe(true)
  })
})

describe("browser session titles", () => {
  test("a given name stays; empty or a bare Browser N becomes a short name from the task", () => {
    expect(browserSessionTitle("Muse регистрация", "x")).toBe("Muse регистрация")
    expect(browserSessionTitle("Browser 3", "Open https://muse.ai and sign up")).toBe("Open muse.ai and sign up")
    expect(browserSessionTitle(undefined, "Поиск цен на билеты")).toBe("Поиск цен на билеты")
    expect(browserSessionTitle("", undefined)).toBe("Browser task")
  })
})

test("quoted route refusal cannot make a debugging task page work",()=>{
 expect(browserRouteRefusal("developer",`Fix this routing error: "${BROWSER_ROUTE_REFUSAL}"`)).toBeUndefined()
 expect(browserRouteRefusal("developer",`> ${BROWSER_ROUTE_REFUSAL}\nOpen https://example.com`)).toContain("BrowserAgent")
})
