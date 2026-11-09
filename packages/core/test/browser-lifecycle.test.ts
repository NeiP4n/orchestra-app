import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
test("retired browser chats cannot be sent tasks or listed in the model roster", () => {
  const text = readFileSync(new URL("../src/tool/plugin/orchestra.ts", import.meta.url), "utf8")
  const target = text.slice(text.indexOf('const target = Effect.fnUntraced'), text.indexOf('// The team as the orchestrator'))
  expect(target).toContain('BrowserLifecycle.retired(String(sessionID))')
  expect(target.indexOf('BrowserLifecycle.retired')).toBeLessThan(target.indexOf('.get(sessionID)'))
  expect(text).toContain('access[session.id] !== "hidden" && !BrowserLifecycle.retired(String(session.id))')
  const runtime = readFileSync(new URL('../src/browser/runtime.ts', import.meta.url), 'utf8')
  const start = runtime.indexOf('export async function closeBlockedBrowser')
  const stop = runtime.slice(start, runtime.indexOf('async function start(', start))
  expect(stop).toContain('Chrome.livePort')
  expect(stop).not.toContain('open(sessionID)')
  expect(stop).not.toContain('kill(pid, "SIGKILL")')
  expect(stop).not.toContain('deleteProfile')
})
