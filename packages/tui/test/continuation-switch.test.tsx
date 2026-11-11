/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ContinuationSwitch } from "../src/component/continuation-switch"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"

for (const width of [32, 80])
  test(`continuation switch waits for settled server state at ${width} columns`, async () => {
    let enabled = true
    let settle: ((value: { enabled: boolean }) => void) | undefined
    let update: ((value: { enabled: boolean }) => void) | undefined
    const writes: boolean[] = []
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig({ language: "ru" })}>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ContinuationSwitch
                access={{
                  get: async () => ({ enabled }),
                  set: (value) => {
                    writes.push(value.enabled)
                    return new Promise((resolve) => {
                      settle = resolve
                    })
                  },
                  onState: (receive) => {
                    update = receive
                    return () => {
                      update = undefined
                    }
                  },
                }}
              />
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width, height: 6 },
    )
    app.renderer.start()
    const click = async () => {
      const button = app.renderer.root.findDescendantById("continuation.toggle")!
      await app.mockMouse.click(button.x + 1, button.y)
      await app.renderOnce()
    }
    try {
      await app.waitForFrame((frame) => frame.includes("ВКЛ"))
      await click()
      await app.waitForFrame((frame) => frame.includes("Приостанавливаем"))
      expect(writes).toEqual([false])
      expect(app.captureCharFrame()).not.toContain("ПАУЗА")
      await click()
      expect(writes).toEqual([false])
      enabled = false
      settle!({ enabled })
      await app.waitForFrame((frame) => frame.includes("ПАУЗА"))
      expect(app.captureCharFrame()).not.toContain("ВКЛ")
      if (process.env.ORCHESTRA_CONTINUATION_PREVIEW)
        await Bun.write(
          process.env.ORCHESTRA_CONTINUATION_PREVIEW + `-${width}.json`,
          JSON.stringify(app.captureSpans()),
        )
      update!({ enabled: true })
      await app.waitForFrame((frame) => frame.includes("ВКЛ"))
    } finally {
      app.renderer.destroy()
    }
  })
