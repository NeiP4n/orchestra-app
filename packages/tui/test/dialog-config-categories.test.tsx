/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { DialogConfig } from "../src/component/dialog-config"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { Keymap } from "../src/context/keymap"
import { ToastProvider } from "../src/ui/toast"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("DialogConfig sets dialog size to large and renders categorized navigation bar", async () => {
  let dialogContext: ReturnType<typeof useDialog> | undefined

  function Harness() {
    dialogContext = useDialog()
    return <DialogConfig />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "opencode", mode: "dark" } })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <Harness />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 35 },
  )

  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Settings") && frame.includes("General"))

  // Verify dialog size is set to large (88 cols)
  expect(dialogContext?.size).toBe("large")

  const frame = app.captureCharFrame()
  // Verify category tabs are rendered
  for (const category of ["All", "General", "Appearance", "Chat", "Agent", "Workspace", "Notifications", "Input", "Developer"])
    expect(frame).toContain(category)

  // Verify rich footer card metadata is rendered
  expect(frame).toContain("path:")
  expect(frame).toContain("default:")
  expect(frame).toContain("tab")
})

test("DialogConfig category tabs filter the visible options when clicked", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "opencode", mode: "dark" } })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <DialogConfig />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 35 },
  )

  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Settings") && frame.includes("General"))

  // Find position of the "Appearance" entry in the category rail
  const lines = app.captureCharFrame().split("\n")
  const catRow = lines.findIndex((l) => l.includes("Appearance"))
  expect(catRow).toBeGreaterThanOrEqual(0)
  const appCol = lines[catRow].indexOf("Appearance")

  // Click on "Appearance" in the rail
  await app.mockMouse.click(appCol + 2, catRow)
  await app.waitForFrame((frame) => frame.includes("Animations") && frame.includes("Mascot"))

  const filteredFrame = app.captureCharFrame()
  expect(filteredFrame).toContain("Animations")
  expect(filteredFrame).toContain("Mascot")
  expect(filteredFrame).not.toContain("AI language")
})
