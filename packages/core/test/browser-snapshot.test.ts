import { describe, expect, test } from "bun:test"
import { BrowserPage } from "../src/browser/page"
import { BrowserTool } from "../src/tool/plugin/browser"

describe("browser snapshot refs", () => {
  test("a ref becomes the selector of the numbered element", () => {
    expect(BrowserPage.refSelector("@e3")).toBe('[data-orc-ref="e3"]')
    expect(BrowserPage.refSelector(" e12 ")).toBe('[data-orc-ref="e12"]')
  })
  test("anything that is not a ref is refused, so it cannot reach the selector", () => {
    for (const bad of ["", "e", "@e3]", 'e1"] , body', "button", "@e-1", "@e123456"])
      expect(() => BrowserPage.refSelector(bad)).toThrow("is not a ref")
  })
  test("the snapshot script is valid JavaScript and writes the ref onto the element", () => {
    const script = BrowserPage.snapshotExpression(50)
    expect(() => new Function(`return ${script}`)).not.toThrow()
    expect(script).toContain("data-orc-ref")
    expect(script).toContain("50")
  })
  test("snapshot is an action of the tool and does not ask for permission", () => {
    expect(BrowserTool.acts("snapshot")).toBe(false)
    expect(BrowserTool.description).toContain("snapshot")
  })
})
