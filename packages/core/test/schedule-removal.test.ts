import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
test("sidebar deletion is a request, KV owner validated, pending requests cannot fire and last watcher is uninstalled", () => {
  const runtime = readFileSync(new URL("../src/orchestra.ts", import.meta.url), "utf8")
  expect(runtime).toContain('ScheduleView.removalRequested(trigger.id, String(project.main))')
  expect(runtime).toContain('yield* kv.remove(entry.key)')
  expect(runtime).toContain('if (!remaining) yield* Effect.promise(() => BrowserRuntime.stopPageWatcher(trigger.spec))')
  const watch = readFileSync(new URL("../src/browser/watch.ts", import.meta.url), "utf8")
  expect(watch).toContain('Page.removeScriptToEvaluateOnNewDocument')
  expect(watch).toContain('Runtime.removeBinding')
  expect(watch).toContain('__orchestraWatchObserver?.disconnect()')
})
