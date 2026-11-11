import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// L2: a relaunch after a crash must not wipe the log that says why the
// previous Chrome died. The log appends across launches, rotates one
// generation aside past a size bound, and the failure tail reaches back
// into the rotated file.
test("chrome stderr log appends across launches and rotates by size", () => {
  const runtime = readFileSync(new URL("../src/browser/runtime.ts", import.meta.url), "utf8")
  // Append mode: the old truncating open destroyed the crash evidence on relaunch.
  expect(runtime).toContain('openRotatingLog(file, STDERR_LIMIT, ".old")')
  expect(runtime).not.toContain('openSync(stderrFile(), "w")')
  // Bounded: one prior generation rotates aside instead of unbounded growth.
  expect(runtime).toContain("const STDERR_LIMIT =")
  // The reported tail reaches into the rotated generation when the fresh file is short.
  expect(runtime).toContain('readFileSync(`${stderrFile()}.old`, "utf8")')
})
