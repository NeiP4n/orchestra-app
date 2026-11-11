import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const read = (file: string) => readFileSync(new URL(`../src/browser/${file}`, import.meta.url), "utf8")

test("the capture helper prints with PW_RENDERFULLCONTENT (2), not 0", () => {
  const helper = read("window-capture.ts")
  expect(helper).toContain("PrintWindow(hwnd, dc, 2)")
  expect(helper).not.toMatch(/PrintWindow\(hwnd, dc, 0\)/)
})

test("the attach command stays as it was, and the last attempt adds nolayer; the helper drops the layered trick for it", () => {
  const helper = read("window-capture.ts")
  expect(helper).toContain('" nolayer"')
  expect(helper).toContain('a[6] == "nolayer"')
  // not layered: the layered bit is cleared and alpha is not set; the proof is that the window is off screen
  expect(helper).toContain("if (noLayer) ex &= ~0x80000;")
  expect(helper).toContain("if (!noLayer) SetLayeredWindowAttributes")
  expect(helper).toContain("could not be kept off screen")
  // PrintWindow still renders full content in this attempt
  expect(helper).toContain("PrintWindow(hwnd, dc, 2)")
})

test("a blank print is retried with software compositing, then without the layered window, before the windowless fallback", () => {
  const runtime = read("runtime.ts")
  const start = runtime.indexOf("next.capture.onProblem")
  const body = runtime.slice(start, runtime.indexOf("} catch (error)", start))
  // first blank: software compositing, capture again; second problem (or other problem): headless
  expect(body).toContain("/blank/i.test(text) && (!softwareCapture.has(sessionID) || !noLayerCapture.has(sessionID))")
  expect(body.indexOf("softwareCapture.add(sessionID)")).toBeGreaterThan(0)
  expect(body).toContain("noLayerCapture.add(sessionID)")
  expect(body).toContain("retrying.add(sessionID)")
  expect(body.indexOf('relaunch(sessionID, "capture", size)')).toBeGreaterThan(0)
  expect(body.indexOf('relaunch(sessionID, "capture", size)')).toBeLessThan(body.lastIndexOf('relaunch(sessionID, "headless", size)'))
  // the flags apply to the capture window only
  const at = runtime.indexOf("softwareCapture.has(sessionID) ? [")
  expect(at).toBeGreaterThan(runtime.indexOf("extraArgs:"))
  expect(runtime.slice(at, at + 120)).toContain('"--disable-gpu-compositing"')
  expect(runtime).toMatch(/headless: !headed/)
})
