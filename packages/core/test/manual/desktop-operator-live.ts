import { expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { DesktopTool } from "@orchestra/core/tool/plugin/desktop"

// Manual proof only: bun test ./test/manual/desktop-operator-live.ts
// Requires the operator's exact valid real-screen grant. This file never grants it.
import { DesktopIsolation } from "../../src/desktop-isolation"
const denial = DesktopIsolation.desktopPlatformDenial(process.env, "win32")
if (process.platform !== "win32" || denial) throw Error(denial || "Manual desktop proof requires Windows")
test("one helper answers a screenshot and a window listing", async () => {
  const prev = process.env.ORCHESTRA_DESKTOP_CAPTURE
  process.env.ORCHESTRA_DESKTOP_CAPTURE = "on"
  try {
    const host = DesktopTool.makeHost()
    try {
      const started = Date.now()
      const shot = await DesktopTool.run(host, { action: "screenshot", width: 640 }, undefined)
      if (typeof shot === "string") throw new Error("expected a screenshot")
      expect(shot.width).toBe(640)
      expect(shot.screenWidth).toBeGreaterThan(0)
      expect((await stat(shot.file)).size).toBeGreaterThan(1000)
      const first = Date.now() - started
      // The second call reuses the running helper instead of starting PowerShell again.
      const again = Date.now()
      await DesktopTool.run(host, { action: "windows" }, undefined)
      expect(Date.now() - again).toBeLessThan(Math.max(first, 1500))
      // The clipboard round-trips through the same helper, quotes and Cyrillic included.
      const text = `opencode 'desktop' тест ${Date.now()}`
      await DesktopTool.run(host, { action: "clipboard", text }, undefined)
      expect(await DesktopTool.run(host, { action: "clipboard" }, undefined)).toBe(text)
    } finally {
      host.close()
    }
  } finally {
    if (prev !== undefined) process.env.ORCHESTRA_DESKTOP_CAPTURE = prev
    else delete process.env.ORCHESTRA_DESKTOP_CAPTURE
  }
}, 60_000)
