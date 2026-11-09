import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// The "capture: ..." line of the browser pane is TUI state only. Every change of it is also written to the browser debug log.
test("a change of the capture line is traced, once per change", () => {
  const source = readFileSync(new URL("../src/component/browser-pane.tsx", import.meta.url), "utf8")
  const at = source.indexOf("let lastCaptureLine")
  expect(at).toBeGreaterThan(0)
  const effect = source.slice(at, at + 600)
  expect(effect).toContain("line === lastCaptureLine")
  expect(effect).toContain("BrowserRuntime.trace(`capture line ${props.sessionID}: ${line}`)")
})
