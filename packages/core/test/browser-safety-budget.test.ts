import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { BrowserBudget } from "@orchestra/core/browser/budget"
import { WindowCapture } from "@orchestra/core/browser/window-capture"
import { Chrome } from "@orchestra/core/browser/chrome"
test("one active profile is the safe ceiling; no claim of one Chromium OS subprocess", () => {
  expect(BrowserBudget.MAX_ACTIVE_PROFILES).toBe(1)
  expect(() => BrowserBudget.requireRoom(0)).not.toThrow()
  expect(() => BrowserBudget.requireRoom(1)).toThrow("one Orchestra Chrome profile")
  expect(() => BrowserBudget.requireRoom(4)).toThrow("safety limit")
  const runtime = readFileSync(new URL("../src/browser/runtime.ts", import.meta.url), "utf8")
  expect(runtime).toContain('Flock.withLock("browser-active-profile-budget"')
  expect(runtime).toContain('dir: path.join(Global.Path.data, "browser-launch-locks")')
  expect(runtime).toContain("return launchLock(() => startLocked(sessionID))")
  expect(runtime).toContain("await checkLaunchBudget()")
  expect(runtime).toContain("const run = await launchLock(async () =>")
  expect(runtime).toContain("AbortSignal.timeout(1000)")
})
test("native capture is bounded to four FPS and 1280x800 and pauses before PrintWindow", () => {
  expect(WindowCapture.captureSize({ width: 8000, height: 4000 })).toEqual({ width: 1280, height: 800 })
  expect(WindowCapture.sizeCommand({ width: 8000, height: 4000 })).toBe("size 1280 800")
  expect(WindowCapture.attachCommand(1, { width: 8000, height: 4000 })).toBe("attach 1 -32000 -32000 1280 800")
  const script = WindowCapture.SCRIPT
  const frame = script.slice(script.indexOf("static void Frame()"), script.indexOf("public static void Run()"))
  expect(frame.indexOf("if (!streaming")).toBeLessThan(frame.indexOf("PrintWindow("))
  expect(frame).toContain("w > 1280 || h > 800")
  expect(script).toContain("next = DateTime.UtcNow.AddMilliseconds(250)")
  const source = readFileSync(new URL("../src/browser/window-capture.ts", import.meta.url), "utf8")
  expect(source).toContain('process.write("stream off")')
  expect(source).toContain('process.write("stream on")')
  expect(Chrome.LOW_MEMORY_FLAGS).not.toContain("--disable-background-timer-throttling")
  expect(Chrome.LOW_MEMORY_FLAGS).not.toContain("--disable-hang-monitor")
})

test("headless image delivery coalesces rapid frames and stops pending work", async () => {
  const { Cdp } = await import("@orchestra/core/browser/cdp")
  let frame: (params: any) => void = () => undefined
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = []
  const client = {
    send: async <T = unknown>(method: string, params?: Record<string, unknown>) => { sent.push({ method, params }); return undefined as T },
    close() {},
    on: (_event: string, listener: (params: any) => void) => { frame = listener; return () => { frame = () => undefined } },
  }
  const frames: string[] = []
  const stop = await Cdp.startScreencast(client, { width: 4000, height: 3000 }, (value) => frames.push(value.data))
  expect(sent[0]).toMatchObject({ method: "Page.startScreencast", params: { maxWidth: 1280, maxHeight: 800, everyNthFrame: 4 } })
  frame({ data: "first", sessionId: 1 })
  for (let i = 2; i < 10; i++) frame({ data: `frame-${i}`, sessionId: i })
  expect(frames).toEqual(["first"])
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(frames).toEqual(["first", "frame-9"])
  frame({ data: "must not render after stop", sessionId: 10 })
  stop()
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(frames).toHaveLength(2)
})
