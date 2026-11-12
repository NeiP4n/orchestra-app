/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ProjectRemovalNotice } from "../src/component/project-removal-notice"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
for (const width of [48,80]) test(`project removal notice ru/${width}`, async () => {
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({language:"ru"})}><ThemeProvider mode="dark" source={emptyThemeSource}><box width={width-2}><ProjectRemovalNotice /></box></ThemeProvider></ConfigProvider></TestTuiContexts>, { width, height: 10 })
  app.renderer.start()
  try {
    await app.waitForFrame(f => f.includes("Orchestra"))
    const text = app.captureCharFrame().replace(/\s+/g," ")
    expect(text.replace(/\s+/g,"" )).toContain(".orchestra")
    expect(text).toContain("останутся")
    await Bun.write(`/tmp/project-removal-ru-${width}.json`,JSON.stringify(app.captureSpans()))
  } finally { app.renderer.destroy() }
})
