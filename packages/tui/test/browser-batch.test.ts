import { expect, test } from "bun:test"
import { browserBatch } from "../src/util/browser-batch"
test("start all sequences unique profiles with pacing, progress and isolated errors", async () => {
  const order: string[] = [], progress: string[] = []
  const result = await browserBatch(["a", "b", "a", "c"], async (id) => { order.push(id); if (id === "b") throw Error("fixture failure") }, (done, total) => progress.push(`${done}/${total}`), async (ms) => { order.push(`wait:${ms}`) })
  expect(order).toEqual(["a", "wait:350", "b", "wait:350", "c"])
  expect(progress).toEqual(["0/3", "1/3", "2/3", "3/3"])
  expect(result.total).toBe(3)
  expect(result.failures.map((f) => f.id)).toEqual(["b"])
})
