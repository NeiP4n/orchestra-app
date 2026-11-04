/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider, resolve, type Info, type Interface } from "../../../src/config"
import { DialogHeader, DialogShell, dialogSpacing } from "../../../src/component/dialog-standard"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { emptyThemeSource } from "../../fixture/fixture"

test("dialog spacing standard keeps the form and list tiers distinct", () => {
  expect(dialogSpacing.formX).toBe(2)
  expect(dialogSpacing.listX).toBe(4)
  expect(dialogSpacing.gap).toBe(1)
})

test("DialogHeader renders the title with the shared esc close chip", async () => {
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
    onMount(() =>
      dialog.replace(() => (
        <DialogShell>
          <DialogHeader title="Standard header" />
          <text>body</text>
        </DialogShell>
      )),
    )
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
    await app.waitForFrame((frame) => frame.includes("Standard header"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("esc")
    expect(frame).toContain("body")
    // Title and chip share the header row: the medium dialog (60 wide) is centered in the
    // 80-wide terminal, so the title starts at the centering offset (10) + formX (2).
    const line = frame.split("\n").find((row) => row.includes("Standard header")) ?? ""
    expect(line).toContain("esc")
    expect(line.indexOf("Standard header")).toBe(12)
  } finally {
    app.renderer.destroy()
  }
})
