import { expect, test } from "bun:test"
import { BrowserKeyQueue } from "@orchestra/core/browser/key-queue"
import { Cdp } from "@orchestra/core/browser/cdp"

test("printable key snapshots retain W then F and serialize slow delivery", async () => {
  const enqueue = BrowserKeyQueue.make()
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const sent: string[] = []
  const reused = { name: "w", sequence: "W" }
  const first = enqueue("b", reused, async (key) => {
    await barrier
    sent.push(key.sequence)
    expect(Cdp.keySteps(key)).toEqual([{ method: "Input.insertText", params: { text: "W" } }])
  })
  reused.name = "f"
  reused.sequence = "F"
  const second = enqueue("b", reused, async (key) => { sent.push(key.sequence) })
  await Promise.resolve()
  expect(sent).toEqual([])
  release()
  await Promise.all([first, second])
  expect(sent).toEqual(["W", "F"])
})

test("failed keys do not stall later keys or another session", async () => {
  const enqueue = BrowserKeyQueue.make()
  const input = { name: "п", sequence: "п" }
  await expect(enqueue("b", input, async () => { throw new Error("disconnected") })).rejects.toThrow("disconnected")
  expect(await enqueue("b", input, async (key) => key.sequence)).toBe("п")
  expect(await enqueue("other", input, async (key) => key.sequence)).toBe("п")
})
