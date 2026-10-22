/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { FlowLine } from "../src/component/flow-rule"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import type { FlowMode } from "../src/effects/flow"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

async function frame(mode: FlowMode, label: string, offset = 0, blink = true) {
  const app = await testRender(
    () => (
      <TestTuiContexts directory="/tmp/opencode/packages/tui">
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <FlowLine mode={mode} label={label} width={10} offset={offset} blink={blink} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 50, height: 3 },
  )
  await app.renderOnce()
  if (mode !== "idle") await app.waitForFrame((current) => current.trim() !== "")
  return app.captureCharFrame()
}

test("an idle line paints nothing and takes no row", async () => {
  expect((await frame("idle", "")).trim()).toBe("")
})

test("streaming shows the flowing pattern with its rate and the pattern moves with the offset", async () => {
  const first = await frame("streaming", "поток · 42 симв/с", 0)
  const later = await frame("streaming", "поток · 42 симв/с", 1)
  expect(first).toContain("░▒▓▒░▒▓▒░▒")
  expect(first).toContain("поток · 42 симв/с")
  expect(later).toContain("▒░▒▓▒░▒▓▒░")
})

test("a stalled line says so and blinks between its two looks", async () => {
  const on = await frame("stalled", "нет данных 14 с · Esc — прервать", 0, true)
  const off = await frame("stalled", "нет данных 14 с · Esc — прервать", 0, false)
  expect(on).toContain("╌╌╌╌╌╌╌╌╌╌")
  expect(off).not.toContain("╌")
  expect(on).toContain("Esc — прервать")
  expect(off).toContain("Esc — прервать")
})
