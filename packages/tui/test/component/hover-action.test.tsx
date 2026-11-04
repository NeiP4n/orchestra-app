import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { HoverAction } from "../../src/component/hover-action"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider, useTheme } from "../../src/context/theme"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("HoverAction isolates click events from parent row", async () => {
  let parentClicked = false
  let buttonClicked = false

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <box
              id="parent-row"
              onMouseUp={() => {
                parentClicked = true
              }}
            >
              <text>Row Content </text>
              <HoverAction
                id="action-btn"
                onClick={() => {
                  buttonClicked = true
                }}
              >
                <text>Click Me</text>
              </HoverAction>
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 10, kittyKeyboard: true },
  )

  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Click Me"))

  const lines = app.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("Click Me"))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = lines[y]!.indexOf("Click Me") + 2

  await app.mockMouse.click(x, y)
  await app.renderOnce()

  expect(buttonClicked).toBe(true)
  expect(parentClicked).toBe(false)
})

test("HoverAction does not trigger when disabled", async () => {
  let clicked = false

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <HoverAction
              id="disabled-btn"
              disabled={true}
              onClick={() => {
                clicked = true
              }}
            >
              <text>Disabled Button</text>
            </HoverAction>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 10, kittyKeyboard: true },
  )

  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Disabled Button"))

  const lines = app.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("Disabled Button"))
  const x = lines[y]!.indexOf("Disabled Button") + 2

  await app.mockMouse.click(x, y)
  await app.renderOnce()

  expect(clicked).toBe(false)
})

test("HoverAction supports destructive hover surfaces and reports pointer state", async () => {
  let hovered = false
  let destructiveHover: number[] = []
  function Probe() {
    const theme = useTheme()
    destructiveHover = theme.background.action.destructive.hovered.toInts()
    return (
      <HoverAction
        id="destructive-action"
        variant="destructive"
        onHoverChange={(value) => (hovered = value)}
      >
        <text>Release resource</text>
      </HoverAction>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Probe />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 10, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Release resource"))
    const action = app.renderer.root.findDescendantById("destructive-action")!
    await app.mockMouse.moveTo(action.x, action.y)
    await app.renderOnce()

    expect(hovered).toBe(true)
    const span = app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((item) => item.text.includes("Release resource"))
    expect(span?.bg.toInts()).toEqual(destructiveHover)

    await app.mockMouse.moveTo(0, 9)
    await app.renderOnce()
    expect(hovered).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})
