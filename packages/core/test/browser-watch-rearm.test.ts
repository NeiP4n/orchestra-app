import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { BrowserWatch } from "@orchestra/core/browser/watch"

test("same CDP client re-arms document without duplicate listeners; missing observer is not ready", async () => {
  const calls: string[] = []
  let ready = false, listeners = 0
  const client = {
    send: async (method: string) => {
      calls.push(method)
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "fixed" }
      return { result: { value: ready } }
    },
    on: () => { listeners++; return () => { listeners-- } },
  } as any
  await BrowserWatch.install("fixture", client)
  expect(calls[0]).toBe("Page.enable")
  expect(await BrowserWatch.ready(client)).toBe(false)
  ready = true
  await BrowserWatch.install("fixture", client)
  expect(await BrowserWatch.ready(client)).toBe(true)
  expect(calls.filter((x) => x === "Runtime.addBinding")).toHaveLength(1)
  expect(listeners).toBe(1)
  await BrowserWatch.uninstall(client)
  expect(listeners).toBe(0)
  await BrowserWatch.install("fixture", client)
  expect(calls.filter((x) => x === "Runtime.addBinding")).toHaveLength(2)
  await BrowserWatch.uninstall(client)
})
test("failed initial evaluate cleans registration and next install retries", async () => {
  let fail = true, listeners = 0
  const client = { send: async (method: string) => {
    if (method === "Runtime.evaluate" && fail) { fail = false; throw new Error("context replaced") }
    return { identifier: "fixture" }
  }, on: () => { listeners++; return () => { listeners-- } } } as any
  await expect(BrowserWatch.install("fixture", client)).rejects.toThrow("context replaced")
  expect(listeners).toBe(0)
  await BrowserWatch.install("fixture", client)
  expect(listeners).toBe(1)
  await BrowserWatch.uninstall(client)
})
test("idle browser sweep does not wait twelve beats before re-arming", () => {
  const source = readFileSync(new URL("../src/orchestra.ts", import.meta.url), "utf8")
  const start = source.indexOf("const fireBrowserTriggers")
  const body = source.slice(start, source.indexOf("yield* Effect.forever", start))
  expect(body).toContain("BrowserWatch.ensure(item.trigger.spec)")
  expect(body).not.toContain("beat % 12")
})
