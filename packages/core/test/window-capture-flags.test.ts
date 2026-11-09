import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const read = (file: string) => readFileSync(new URL(`../src/browser/${file}`, import.meta.url), "utf8")

test("the capture helper prints with PW_RENDERFULLCONTENT (2), not 0", () => {
  const helper = read("window-capture.ts")
  expect(helper).toContain("PrintWindow(hwnd, dc, 2)")
  expect(helper).not.toMatch(/PrintWindow\(hwnd, dc, 0\)/)
})

test("a blank print is retried once with software compositing before the windowless fallback", () => {
  const runtime = read("runtime.ts")
  const start = runtime.indexOf("next.capture.onProblem")
  const body = runtime.slice(start, runtime.indexOf("} catch (error)", start))
  // first blank: software compositing, capture again; second problem (or other problem): headless
  expect(body).toContain("/blank/i.test(text) && !softwareCapture.has(sessionID)")
  expect(body.indexOf('relaunch(sessionID, "capture", size)')).toBeGreaterThan(0)
  expect(body.indexOf('relaunch(sessionID, "capture", size)')).toBeLessThan(body.lastIndexOf('relaunch(sessionID, "headless", size)'))
  // the flags apply to the capture window only
  const at = runtime.indexOf("softwareCapture.has(sessionID) ? [")
  expect(at).toBeGreaterThan(runtime.indexOf("extraArgs:"))
  expect(runtime.slice(at, at + 120)).toContain('"--disable-gpu-compositing"')
  expect(runtime).toMatch(/headless: !headed/)
})
