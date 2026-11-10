/** @jsxImportSource @opentui/solid */
import { test, expect, mock } from "bun:test"
import { writeFileSync } from "node:fs"
let mode = "headless"
const relaunches: string[] = []
mock.module("../../src/util/browser-runtime", () => ({
  isOpen: () => true,
  modeOf: () => mode,
  scheduleStatus: () => [],
  subscribeBrowserState: () => () => {},
  browserState: () => undefined,
  browserResources: () => ({ connectedProfiles: 1, freeGB: 6, totalGB: 16 }),
  tabs: async () => [{ id: "fixture", title: "Fixture", url: "about:blank", active: true }],
  watch: async (_id: string, _size: unknown, onFrame: (v: unknown) => void) =>
    onFrame({ data: Buffer.from(diffImageFixture).toString("base64"), width: 96, height: 48 }),
  unwatch: () => {},
  agentCursor: () => undefined,
  trace: () => {},
  leases: () => ({}),
  captureAttemptOf: () => 0,
  captureProblemOf: () => undefined,
  captureRetrying: () => false,
  relaunch: async (_id: string, next: string) => {
    relaunches.push(next)
    mode = next
  },
}))
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "./tui-environment"
import { createTuiResolvedConfig } from "./tui-runtime"
import { tmpdir, emptyThemeSource } from "./fixture"
import { diffImageFixture } from "./diff-image"
const { BrowserPane } = await import("../../src/component/browser-pane")
test("coarse-terminal browser offers a readable real window without extra profiles, and a way back", async () => {
  await using root = await tmpdir()
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: root.path, home: root.path, worktree: root.path }}>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false, language: "ru" })}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <BrowserPane sessionID="fixture" name="Fixture" chatHidden={false} canShowChat={false} onToggleChat={() => {}} />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 34, useThread: false, kittyKeyboard: true },
  )
  try {
    app.renderer.start()
    await new Promise((done) => setTimeout(done, 450))
    await app.renderOnce()
    let frame = app.captureCharFrame()
    expect(frame).toContain("Чётко в окне")
    expect(relaunches).toEqual([])
    const screenY=frame.split("\n").findIndex(line=>line.includes("Экран: выкл")), screenX=frame.split("\n")[screenY]!.indexOf("Экран: выкл")
    await app.mockMouse.click(screenX+2,screenY)
    await new Promise(done=>setTimeout(done,300)); await app.renderOnce()
    frame=app.captureCharFrame()
    expect(frame).toContain("Экран: вкл")
    const y = frame.split("\n").findIndex((line) => line.includes("Чётко в окне")),
      x = frame.split("\n")[y]!.indexOf("Чётко в окне")
    if (process.env.ORCHESTRA_CAPTURE_SCHEDULES)
      writeFileSync("/downloads/browser-graphics.spans.json", JSON.stringify(app.captureSpans()))
    await app.mockMouse.click(x + 2, y)
    await app.renderOnce()
    await new Promise((done) => setTimeout(done, 10))
    await app.renderOnce()
    frame = app.captureCharFrame()
    expect(relaunches).toEqual(["window"])
    expect(frame).toContain("Встроить")
    expect(frame).toContain("Chrome")
  } finally {
    app.renderer.destroy()
  }
})
