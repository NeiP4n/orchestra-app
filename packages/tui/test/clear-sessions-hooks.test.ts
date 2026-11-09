import { expect, test } from "bun:test"
import { listEverySession, removeEverySession } from "../src/util/clear-sessions"
test("cleanup deduplicates pages, cleans only successful sessions, and reports stop/delete failures", async () => {
  const calls: string[] = []
  const api = { list: async () => ({ data: [{ id: "a" }, { id: "b" }], cursor: {} }), remove: async ({ sessionID }: { sessionID: string }) => { calls.push(`remove:${sessionID}`) } } as any
  const list = await listEverySession(api)
  expect(list).toHaveLength(2)
  const result = await removeEverySession(api, list, {
    before: async ({ id }) => { calls.push(`before:${id}`); if (id === "b") throw new Error("Chrome did not stop") },
    after: async ({ id }) => { calls.push(`after:${id}`) },
  })
  expect(calls).toEqual(["before:a", "remove:a", "after:a", "before:b"])
  expect(result.removed).toBe(1)
  expect(result.failures).toEqual(["Chrome did not stop"])
})
