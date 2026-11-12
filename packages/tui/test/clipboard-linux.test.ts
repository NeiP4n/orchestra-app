import { expect, test } from "bun:test"
import { createLinuxClipboardFallback, linuxClipboardCommands, LINUX_PASTE_HINT, runClipboardCommand } from "../src/clipboard-linux"
import { TuiKeybind } from "../src/config/keybind"

test("Linux Ctrl+V is bound to prompt paste", () => {
  expect(JSON.stringify(TuiKeybind.defaultValue("prompt.paste"))).toContain("ctrl+v")
})
test("Wayland then X11 clipboard fallbacks preserve plain text without executing it", async () => {
  const calls: string[] = []
  const text = "$(do-not-run)\n'quoted'\n世界"
  const read = createLinuxClipboardFallback({ environment: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, run: async command => { calls.push(command[0]); return command[0] === "xsel" ? text : undefined } })
  expect(await read()).toEqual({ mime: "text/plain", data: text })
  expect(calls).toEqual(["wl-paste", "xclip", "xsel"])
})
test("empty clipboard is not an error and does not fall through to another selection", async () => {
  const calls: string[] = []
  const read = createLinuxClipboardFallback({ environment: { DISPLAY: ":0" }, run: async command => { calls.push(command[0]); return "" } })
  expect(await read()).toBeUndefined()
  expect(calls).toEqual(["xclip"])
})
test("missing tool gives terminal paste and install hints", async () => {
  const read = createLinuxClipboardFallback({ environment: { DISPLAY: ":0" }, run: async () => undefined })
  await expect(read()).rejects.toThrow("Ctrl+Shift+V")
  expect(LINUX_PASTE_HINT).toContain("wl-clipboard")
  expect(LINUX_PASTE_HINT).toContain("xclip/xsel")
  expect(linuxClipboardCommands({})).toEqual([])
})
test("SSH never invokes a remote desktop clipboard tool", async () => {
  let calls = 0
  const read = createLinuxClipboardFallback({ environment: { SSH_CONNECTION: "remote", DISPLAY: ":0" }, run: async () => { calls++; return "private server text" } })
  await expect(read()).rejects.toThrow("SSH")
  expect(calls).toBe(0)
})
test("command runner reports an unavailable executable without leaking stderr", async () => {
  expect(await runClipboardCommand(["orchestra-clipboard-command-not-installed"])).toBeUndefined()
})
