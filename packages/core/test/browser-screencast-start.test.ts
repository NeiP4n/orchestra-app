import { expect, test } from "bun:test"
import { Cdp } from "../src/browser/cdp"

test("idle screencast gets one initial screenshot without a recurring screenshot loop", async () => {
  const sent: string[] = []; let listeners = 0
  const client = {
    send: async <T = unknown>(method: string) => { sent.push(method); return { data: "fixture-png" } as T },
    close() {},
    on: () => { listeners++; return () => { listeners-- } },
  }
  const frames: string[] = []
  const stop = await Cdp.startScreencast(client, { width: 400, height: 300 }, frame => frames.push(frame.data))
  try {
    expect(sent.slice(0, 2)).toEqual(["Page.enable", "Page.startScreencast"])
    await new Promise(done => setTimeout(done, 2150))
    expect(frames).toEqual(["fixture-png"])
    expect(sent.filter(method => method === "Page.captureScreenshot")).toHaveLength(1)
  } finally { stop() }
  expect(listeners).toBe(0)
})

test("failed screencast setup removes its listener and leaves no fallback timer", async () => {
  let listeners = 0
  const sent: string[] = []
  const client = {
    send: async <T = unknown>(method: string) => { sent.push(method); if (method === "Page.startScreencast") throw new Error("CDP closed"); return undefined as T },
    close() {},
    on: () => { listeners++; return () => { listeners-- } },
  }
  await expect(Cdp.startScreencast(client, { width: 400, height: 300 }, () => { throw new Error("late frame") })).rejects.toThrow("CDP closed")
  expect(listeners).toBe(0)
  expect(sent).toContain("Page.stopScreencast")
  expect(sent).not.toContain("Page.captureScreenshot")
})
