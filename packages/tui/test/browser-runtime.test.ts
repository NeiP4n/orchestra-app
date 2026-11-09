import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// The Browser view's wiring is checked on the source: Chrome never starts on its own, every session
// uses its own profile directory, and the chat stays beside the page in a wide window.
const read = (file: string) => fs.readFileSync(path.join(import.meta.dir, "..", "src", file), "utf8")

describe("browser view", () => {
  test("Chrome starts only on request, on a per-session profile, and closes with the TUI", () => {
    const core = fs.readFileSync(path.join(import.meta.dir, "..", "..", "core", "src", "browser", "runtime.ts"), "utf8")
    expect(core).toContain("Chrome.profileDir(Global.Path.data, sessionID)")
    expect(core).toContain('process.on("exit", closeAll)')
    expect(read("util/browser-runtime.ts")).toContain("@orchestra/core/browser/runtime")
    expect(read("component/browser-pane.tsx")).toContain("Open Chrome")
  })

  test("the page is streamed into the pane with the terminal's own image protocol", () => {
    const pane = read("component/browser-pane.tsx")
    expect(pane).toContain("ImageRenderable")
    expect(pane).toContain("BrowserRuntime.watch(")
    expect(pane).toContain("BrowserRuntime.unwatch(")
  })

  test("the pane draws its own tab strip and address row above the page picture; the real Chrome window is only the explicit button", () => {
    const pane = read("component/browser-pane.tsx")
    expect(pane).not.toContain("<input")
    for (const used of ["BrowserRuntime.tabs(", "BrowserRuntime.newTab(", "BrowserRuntime.selectTab(", "BrowserRuntime.history("])
      expect(pane).toContain(used)
    expect(pane.indexOf("tabList()")).toBeLessThan(pane.indexOf("<browserImage"))
    expect(pane).toContain("BrowserRuntime.relaunch(")
  })

  test("the operator can take control and always give it back", () => {
    const pane = read("component/browser-pane.tsx")
    expect(pane).toContain("BrowserRuntime.mouse(")
    expect(pane).toContain("BrowserRuntime.key(")
    expect(pane).toContain('key.ctrl && key.name === "g"')
  })

  test("the chat is shown beside the page only in a wide window", () => {
    const frame = read("component/session-frame.tsx")
    expect(frame).toContain('centerView() === "browser" && dimensions().width >= 110')
    expect(frame).toContain("availableWidth() >= CHAT_BESIDE_WIDTH + 50")
    // The page comes first in the row and the chat after it (not relying on row-reverse): page in the center, chat on the right.
    expect(frame.indexOf('id="center-view"')).toBeGreaterThan(0)
    expect(frame.indexOf('id="center-view"')).toBeLessThan(frame.indexOf('id="session-pane"'))
    expect(frame).not.toContain("row-reverse")
  })

  test("the chat column can be hidden and the choice is saved in the layout", () => {
    const frame = read("component/session-frame.tsx")
    expect(frame).toContain("draft.browserChatHidden = hidden")
    expect(frame).toContain("&& !browserChatHidden()")
    expect(read("component/browser-pane.tsx")).toContain("Hide chat")
  })
})

describe("the browser pane default", () => {
  test("opening a session streams the windowless Chrome on every system; the real window is an explicit button", () => {
    const pane = read("component/browser-pane.tsx")
    expect(pane).not.toMatch(/win32"\s*&&\s*state\(\)\s*===\s*"ready"\s*&&\s*mode\(\)\s*===\s*"headless"\)\s*switchMode/)
    expect(pane).toContain('switchMode("capture")')
  })
})
