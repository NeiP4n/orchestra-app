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

import { BrowserDevtools } from "../src/browser/devtools"

describe("browser devtools actions", () => {
  test("eval refuses reading cookies, storage and passwords, and sending data out", () => {
    for (const bad of [
      "document.cookie",
      "localStorage.getItem('t')",
      "fetch('/x', {method:'POST'})",
      "document.querySelector('form').submit()",
      "document.querySelector('input[type=password]').value",
      "",
    ])
      expect(BrowserDevtools.refuseExpression(bad)).toBeDefined()
    expect(BrowserDevtools.refuseExpression("document.title")).toBeUndefined()
    expect(BrowserDevtools.refuseExpression("document.querySelectorAll('a').length")).toBeUndefined()
  })
  test("redact cuts tokens, jwts and long keys", () => {
    expect(BrowserDevtools.redact("Authorization: Bearer abcdef1234567890")).not.toContain("abcdef1234567890")
    expect(BrowserDevtools.redact("token=supersecretvalue")).toBe("token=[redacted]")
    expect(BrowserDevtools.redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcd1234")).toBe("[redacted jwt]")
    expect(BrowserDevtools.redact("x".repeat(50))).toBe("[redacted key]")
    expect(BrowserDevtools.redact("Hello world")).toBe("Hello world")
  })
  test("network addresses lose their query values and credentials", () => {
    expect(BrowserDevtools.safeUrl("https://user:pw@a.test/p?token=abc&x=1#h")).toBe("https://a.test/p?token=%E2%80%A6&x=%E2%80%A6")
  })
  test("cookies are listed without values", () => {
    const text = BrowserDevtools.formatCookies([{ name: "sid", domain: "a.test", path: "/", secure: true, httpOnly: true }])
    expect(text).toContain("sid @ a.test/")
    expect(text).toContain("value hidden")
  })
  test("the eval script and the storage script are valid JavaScript", () => {
    expect(() => new Function(`return (${BrowserDevtools.evalExpression("1+1").functionDeclaration})`)).not.toThrow()
    expect(() => new Function(`return ${BrowserDevtools.storageExpression}`)).not.toThrow()
  })
  test("eval asks for permission", () => {
    expect(BrowserTool.acts("eval")).toBe(true)
    expect(BrowserTool.acts("console")).toBe(false)
  })
})

describe("scripts sent to the page are valid JavaScript", () => {
  test("snapshot keeps its newline and whitespace escapes inside the script text", () => {
    const script = BrowserPage.snapshotExpression(5)
    expect(() => new Function(`return ${script}`)).not.toThrow()
    expect(script).toContain("join('\\n')")
    expect(script).toContain("/\\s+/g")
  })
  test("eval and storage scripts parse", () => {
    expect(() => new Function(`return (${BrowserDevtools.evalExpression("1 + 1").functionDeclaration})`)).not.toThrow()
    expect(() => new Function(`return ${BrowserDevtools.storageExpression}`)).not.toThrow()
  })
})
