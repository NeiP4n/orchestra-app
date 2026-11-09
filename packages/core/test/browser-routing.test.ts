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
