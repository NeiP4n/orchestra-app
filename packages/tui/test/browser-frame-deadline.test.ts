import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { firstFrameDeadline } from "../src/util/browser-frame-deadline"

function clock() {
  let next = 0
  const callbacks = new Map<number, () => void>()
  return { schedule: (cb: () => void) => { callbacks.set(++next, cb); return next as never },
    cancel: (id: ReturnType<typeof setTimeout>) => { callbacks.delete(id as never) },
    tick: () => { const batch = [...callbacks.values()]; callbacks.clear(); batch.forEach(cb => cb()) }, size: () => callbacks.size }
}

test("missing or never-resolving image setup still reaches its own five-second deadline", () => {
  const c = clock(); const seconds: number[] = []; let failures = 0
  firstFrameDeadline({ onTick: n => seconds.push(n), onTimeout: () => failures++, schedule: c.schedule, cancel: c.cancel })
  for (let i = 0; i < 4; i++) c.tick()
  expect(failures).toBe(0)
  c.tick()
  expect(seconds).toEqual([1, 2, 3, 4, 5])
  expect(failures).toBe(1)
  c.tick(); expect(failures).toBe(1)
})

test("first decoded frame or pane cleanup cancels pending deadline work", () => {
  const c = clock(); let failures = 0
  const stop = firstFrameDeadline({ onTick: () => {}, onTimeout: () => failures++, schedule: c.schedule, cancel: c.cancel })
  c.tick(); stop(); for (let i = 0; i < 8; i++) c.tick()
  expect(failures).toBe(0); expect(c.size()).toBe(0)
})

test("all BrowserPane runtime calls are exported by the TUI facade, including peek", () => {
  const wrapper = readFileSync(new URL("../src/util/browser-runtime.ts", import.meta.url), "utf8")
  const pane = readFileSync(new URL("../src/component/browser-pane.tsx", import.meta.url), "utf8")
  const start = wrapper.indexOf("export const {")
  const end = wrapper.indexOf("} = BrowserRuntime", start)
  const names = new Set(wrapper.slice(start, end).match(/\b[a-zA-Z][a-zA-Z0-9]*\b/g))
  names.add("scheduleStatus")
  for (const [, name] of pane.matchAll(/BrowserRuntime\.(\w+)/g)) expect(names.has(name)).toBe(true)
  expect(names.has("peek")).toBe(true)
  expect(pane).toContain("frameRetries < 1")
  expect(pane).toContain('label="Повторить"')
  expect(pane).toContain('label="К тексту"')
  expect(pane).not.toContain('t("Waiting for the page picture...")')
  expect(pane).toContain('background={tab.active ? selectionBackground(theme)')
})
