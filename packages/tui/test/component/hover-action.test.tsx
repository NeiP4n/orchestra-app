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
  let destructiveHover: [number, number, number, number] = [0, 0, 0, 0]
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

test("HoverAction keeps a press that moves between its own children", async () => {
  let clicks = 0

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <HoverAction
              id="multi-child"
              gap={1}
              onClick={() => {
                clicks += 1
              }}
            >
              <text>Alpha</text>
              <text>Beta</text>
            </HoverAction>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 10, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Alpha") && frame.includes("Beta"))
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("Alpha"))
    const alpha = lines[y]!.indexOf("Alpha") + 2
    const beta = lines[y]!.indexOf("Beta") + 2

    // The press began on the first child and ends on the second: still one press
    // of the same action, so it must click.
    await app.mockMouse.pressDown(alpha, y)
    await app.mockMouse.moveTo(beta, y)
    await app.mockMouse.release(beta, y)
    await app.renderOnce()

    expect(clicks).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("HoverAction fires on every complete click, not only the first", async () => {
  let clicks = 0

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <HoverAction
              id="twice"
              onClick={() => {
                clicks += 1
              }}
            >
              <text>Push</text>
            </HoverAction>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 10, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Push"))
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("Push"))
    const x = lines[y]!.indexOf("Push") + 2

    await app.mockMouse.click(x, y)
    await app.renderOnce()
    await app.mockMouse.click(x, y)
    await app.renderOnce()

    expect(clicks).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})
