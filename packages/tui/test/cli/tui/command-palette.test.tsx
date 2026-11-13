/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider, resolve, type Info, type Interface } from "../../../src/config"
import { CommandPaletteDialog } from "../../../src/component/command-palette"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { emptyThemeSource } from "../../fixture/fixture"

test("searches settings globally and opens the matching setting", async () => {
  let current: Info = {}
  const service: Interface = {
    get: async () => current,
    update: async (update) => {
      const draft = structuredClone(current)
      update(draft)
      current = draft
      return current
    },
  }

  function Fixture() {
    const dialog = useDialog()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        {
          id: "session.new",
          title: "New session",
          group: "Session",
          palette: true,
          run() {},
        },
        {
          id: "model.list",
          title: "Switch model",
          group: "Agent",
          palette: true,
          run() {},
        },
      ],
    }))
    onMount(() => dialog.replace(() => <CommandPaletteDialog />))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={resolve(current, { terminalSuspend: true })} service={service}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Fixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("New session"))
    expect(app.captureCharFrame()).not.toContain("Animations")
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)

    app.mockInput.pressArrow("down")
    for (const key of "image preview") app.mockInput.pressKey(key)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Settings") && frame.includes("Image previews"))
    app.mockInput.pressEnter()
    await app.waitFor(() => current.prompt?.image_preview === true)
  } finally {
    app.renderer.destroy()
  }
})

test("browses commands and settings by category with counts, tab navigation, and no duplicates", async () => {
  let current: Info = {}
  const service: Interface = {
    get: async () => current,
    update: async (update) => {
      const draft = structuredClone(current)
      update(draft)
      current = draft
      return current
    },
  }

  function Fixture() {
    const dialog = useDialog()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        { id: "session.new", title: "New session", group: "Session", palette: true, suggested: true, run() {} },
        { id: "session.list", title: "List sessions", group: "Session", palette: true, run() {} },
        { id: "agent.switch", title: "Switch agent", group: "Agent", palette: true, run() {} },
        { id: "git.status", title: "Git status", group: "Git", palette: true, run() {} },
      ],
    }))
    onMount(() => dialog.replace(() => <CommandPaletteDialog />))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={resolve(current, { terminalSuspend: true })} service={service}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Fixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    // The rail lists every non-empty category: All, Suggested, the canonical
    // command categories (the legacy "Git" group collapses into VCS), then the
    // settings sections. All holds 4 commands + 11 settings.
    await app.waitForFrame((frame) => frame.includes("· 15 options"))
    const all = app.captureCharFrame()
    for (const label of ["All", "Suggested", "Session", "Agent", "VCS", "General", "Chat", "Notifications", "Developer"])
      expect(all).toContain(label)
    // A suggested command appears exactly once in the All view.
    expect(all.split("New session").length - 1).toBe(1)

    // Tab cycles: All -> Suggested shows only the suggested command.
    app.mockInput.pressTab()
    await app.waitForFrame((frame) => frame.includes("Suggested") && frame.includes("· 1 options"))
    expect(app.captureCharFrame()).not.toContain("Switch agent")

    // Session shows both session commands and nothing else.
    app.mockInput.pressTab()
    await app.waitForFrame((frame) => frame.includes("· 2 options"))
    const session = app.captureCharFrame()
    expect(session).toContain("List sessions")
    expect(session).not.toContain("Switch agent")
    expect(session).not.toContain("Git status")

    // Agent, then VCS (the collapsed legacy Git group).
    app.mockInput.pressTab()
    await app.waitForFrame((frame) => frame.includes("· 1 options") && frame.includes("Switch agent"))
    app.mockInput.pressTab()
    await app.waitForFrame((frame) => frame.includes("Git status") && frame.includes("· 1 options"))
    expect(app.captureCharFrame()).not.toContain("New session")

    // Shift+Tab walks back to Agent. (Raw CSI Z: the sequence real terminals
    // send for shift+tab, and the one the keymap matches.)
    await app.mockInput.pressKeys(["\x1b[Z"])
    await app.waitForFrame((frame) => frame.includes("Switch agent") && frame.includes("· 1 options"))

    // Forward again through VCS into the first settings section: settings are
    // browsable without typing, and no commands leak into the section.
    app.mockInput.pressTab()
    await app.waitForFrame((frame) => frame.includes("Git status"))
    app.mockInput.pressTab()
    await app.waitForFrame(frame => frame.includes("Безопасность · 2 options"))
    app.mockInput.pressTab()
    await app.waitForFrame(frame => frame.includes("Профиль · 2 options"))
    app.mockInput.pressTab()
    await app.waitForFrame((frame) => frame.includes("Language") && frame.includes("· 3 options"))
    const general = app.captureCharFrame()
    expect(general).toContain("AI language")
    expect(general).not.toContain("New session")

    // Enter on a setting opens the settings dialog at that setting.
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Settings") && frame.includes("AI language"))
  } finally {
    app.renderer.destroy()
  }
})
