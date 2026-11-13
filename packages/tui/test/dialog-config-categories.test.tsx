/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { DialogConfig } from "../src/component/dialog-config"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { ThemeProvider } from "../src/context/theme"
import { Keymap } from "../src/context/keymap"
import { ToastProvider } from "../src/ui/toast"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"

// The dialog writes only the interface config; the client stub serves an empty server config.
const serverApi = () =>
  createApi(
    createFetch(async (url) => {
      if (url.pathname === "/api/config") return json([])
    }, createEventStream()).fetch,
  )

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
          <ClientProvider api={serverApi()}>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <Keymap.Provider>
                <ToastProvider>
                  <DialogProvider>
                    <Harness />
                  </DialogProvider>
                </ToastProvider>
              </Keymap.Provider>
            </ThemeProvider>
          </ClientProvider>
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
  for (const category of ["All", "General", "Chat", "Безопасность", "Notifications", "Developer", "Профиль"])
    expect(frame).toContain(category)

  // Verify rich footer card metadata is rendered: the default stays, the internal config
  // path is engineering detail the dialog no longer shows.
  expect(frame).not.toContain("path:")
  expect(frame).not.toContain("default:")
  expect(frame).toContain("Tab category")
})

test("DialogConfig category tabs filter the visible options when clicked", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "opencode", mode: "dark" } })}>
          <ClientProvider api={serverApi()}>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <Keymap.Provider>
                <ToastProvider>
                  <DialogProvider>
                    <DialogConfig />
                  </DialogProvider>
                </ToastProvider>
              </Keymap.Provider>
            </ThemeProvider>
          </ClientProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 35 },
  )

  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Settings") && frame.includes("General"))

  // Find position of the "Chat" entry in the category rail
  const lines = app.captureCharFrame().split("\n")
  const catRow = lines.findIndex((l) => l.includes("Chat"))
  expect(catRow).toBeGreaterThanOrEqual(0)
  const appCol = lines[catRow].indexOf("Chat")

  // Click on "Chat" in the rail
  await app.mockMouse.click(appCol + 2, catRow)
  // "Verbosity" is visible in the unfiltered list too, so wait for the
  // filtered state itself: a General option must be gone.
  await app.waitForFrame((frame) => frame.includes("Verbosity") && !frame.includes("AI language"))

  const filteredFrame = app.captureCharFrame()
  expect(filteredFrame).toContain("Verbosity")
  expect(filteredFrame).not.toContain("AI language")
})

test("decluttered tuning knobs are not listed even with Developer mode on", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ developer: true, theme: { name: "opencode", mode: "dark" } })}>
          <ClientProvider api={serverApi()}>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <Keymap.Provider>
                <ToastProvider>
                  <DialogProvider>
                    <DialogConfig />
                  </DialogProvider>
                </ToastProvider>
              </Keymap.Provider>
            </ThemeProvider>
          </ClientProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 45 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Settings") && frame.includes("Permissions"))

  // The whole list fits in the frame, so missing rows are removed, not scrolled away.
  const frame = app.captureCharFrame()
  expect(frame).toContain("Permissions")
  for (const removed of ["Context governor", "Auto-compact", "Developer tools", "Animations", "Mascot", "Tabs", "Mouse"])
    expect(frame).not.toContain(removed)
})

for (const width of [80, 120, 160]) test(`Settings retains right-side options at ${width} columns`, async () => {
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({ theme: { name: "opencode", mode: "dark" } })}><ClientProvider api={serverApi()}><ThemeProvider mode="dark" source={emptyThemeSource}><Keymap.Provider><ToastProvider><DialogProvider><DialogConfig /></DialogProvider></ToastProvider></Keymap.Provider></ThemeProvider></ClientProvider></ConfigProvider></TestTuiContexts>, { width, height: 40 })
  app.renderer.start()
  await app.waitForFrame(frame => frame.includes("AI language") && frame.includes("Theme"))
  const frame = app.captureCharFrame()
  expect(frame).toContain("Language")
  expect(frame).toContain("AI language")
  expect(frame).toContain("Theme")
  app.renderer.destroy()
})
