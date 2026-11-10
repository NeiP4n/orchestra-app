import { expect, test } from "bun:test"
import { Cdp } from "../src/browser/cdp"
import { BrowserPage } from "../src/browser/page"
import { BrowserDevtools } from "../src/browser/devtools"

const hostile = `x'); globalThis.injected = true; //\n\u2028\u2029\"\\` + "\ud800"

test("selector, text, and eval input never enter the page function source", () => {
  for (const call of [
    BrowserPage.clickExpression({ selector: hostile }),
    BrowserPage.clickExpression({ text: hostile }),
    BrowserPage.typeExpression({ selector: hostile, text: hostile }),
    BrowserPage.typeExpression({ selector: hostile, text: hostile, native: true }),
    BrowserDevtools.evalExpression(hostile),
  ]) {
    expect(call.functionDeclaration).not.toContain(hostile)
    expect(JSON.stringify(call.arguments)).toContain(JSON.stringify(hostile).slice(1, -1))
    expect(() => new Function(`return (${call.functionDeclaration})`)).not.toThrow()
  }
  expect(BrowserPage.clickExpression({ selector: hostile }).functionDeclaration).toBe(
    BrowserPage.clickExpression({ selector: "#safe" }).functionDeclaration,
  )
  expect(BrowserDevtools.evalExpression(hostile).functionDeclaration).toBe(
    BrowserDevtools.evalExpression("1+1").functionDeclaration,
  )
})

test("CDP keeps data arguments separate, awaits the result, and releases its exact object", async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const client: Cdp.Client = {
    close() {},
    on() {
      return () => {}
    },
    async send<T>(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params })
      return (
        method === "Runtime.evaluate"
          ? { result: { objectId: "target-1" } }
          : { result: { value: { ok: true, text: "2" } } }
      ) as T
    },
  }
  const call = BrowserDevtools.evalExpression("1+1")
  expect(await Cdp.callPage<{ result: { value: { ok: boolean; text: string } } }>(client, call, true)).toEqual({
    result: { value: { ok: true, text: "2" } },
  })
  expect(calls.map((c) => c.method)).toEqual(["Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.releaseObject"])
  expect(calls[1].params).toEqual({ ...call, objectId: "target-1", returnByValue: true, awaitPromise: true })
  expect(calls[2].params).toEqual({ objectId: "target-1" })
})

test("a failed page function still releases its remote object, and a missing context fails closed", async () => {
  const methods: string[] = []
  const client: Cdp.Client = {
    close() {},
    on() {
      return () => {}
    },
    async send<T>(method: string) {
      methods.push(method)
      if (method === "Runtime.callFunctionOn") throw Error("page gone")
      return { result: { objectId: "gone-1" } } as T
    },
  }
  await expect(Cdp.callPage(client, BrowserPage.clickExpression({ selector: "x" }))).rejects.toThrow("page gone")
  expect(methods).toEqual(["Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.releaseObject"])
  methods.length = 0
  const missing: Cdp.Client = {
    ...client,
    send: async <T>(method: string) => {
      methods.push(method)
      return {} as T
    },
  }
  await expect(Cdp.callPage(missing, BrowserDevtools.evalExpression("1"))).rejects.toThrow("unavailable")
  expect(methods).toEqual(["Runtime.evaluate"])
})
