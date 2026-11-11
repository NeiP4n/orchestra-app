import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// A session made without a task has no outstanding task, so no report will come. The Orchestrator was told only
// "Created. VERIFIED" and could say "launched" and end its turn. The create result must say, in the no-text branch, that nothing runs.
test("sessions create without text tells the Orchestrator that no task was sent and no report will come", () => {
  const source = readFileSync(new URL("../src/tool/plugin/orchestra.ts", import.meta.url), "utf8")
  const start = source.indexOf("output: `Created. VERIFIED")
  expect(start).toBeGreaterThan(0)
  const line = source.slice(start, source.indexOf("\n", start))
  const withText = line.indexOf("input.text?.trim() ?")
  expect(withText).toBeGreaterThan(0)
  const queued = line.indexOf("task queued")
  const none = line.indexOf("NO TASK WAS SENT")
  // the "queued" wording belongs to the text branch, the warning to the other one, and the warning names the way out
  expect(queued).toBeGreaterThan(withText)
  expect(none).toBeGreaterThan(queued)
  expect(line.slice(none)).toContain("sessions action=send")
})
