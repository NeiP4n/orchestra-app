import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// The pane reads the tab list every 1.5 s (400 ms while it is empty). That read must never create a tab.
test("BrowserRuntime.tabs only reads: an empty list does not open a blank tab", () => {
  const source = readFileSync(new URL("../src/browser/runtime.ts", import.meta.url), "utf8")
  const start = source.indexOf("export async function tabs(")
  const end = source.indexOf("\nexport ", start + 10)
  const body = source.slice(start, end)
  expect(start).toBeGreaterThan(0)
  expect(body).not.toContain("BrowserTabs.create")
  expect(body).toMatch(/list\.length === 0\) return \[\]/)
  // the explicit ways to open a tab are still there
  const open = source.slice(source.indexOf("export async function newTab("))
  expect(open.slice(0, 400)).toContain("BrowserTabs.create")
})
