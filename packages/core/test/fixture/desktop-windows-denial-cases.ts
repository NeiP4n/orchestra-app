import { expect, test } from "bun:test"
import { DesktopTool } from "../../src/tool/plugin/desktop"

// The platform override and environment die with this child. Never enable real-screen access.
Object.defineProperty(process, "platform", { value: "win32", configurable: true })
process.env.ORCHESTRA_DESKTOP_CAPTURE = "on"
for (const key of [
  "ORCHESTRA_DESKTOP_REAL_SCREEN",
  "ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST",
  "ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL",
])
  delete process.env[key]

test("Windows refuses screenshot, window listing and clipboard without real-screen approval", async () => {
  const host = DesktopTool.makeHost()
  try {
    for (const step of [
      { action: "screenshot", width: 640 },
      { action: "windows" },
      { action: "clipboard", text: "must not touch the clipboard" },
      { action: "clipboard" },
    ] as const) {
      await expect(DesktopTool.run(host, step, undefined)).rejects.toThrow("On Windows there is no virtual display")
    }
  } finally {
    host.close()
  }
})
