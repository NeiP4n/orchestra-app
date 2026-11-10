/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Keymap } from "../src/context/keymap"
import { RegistryVault } from "../src/component/registry-vault"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("Vault add mouse click opens injected native collector once without supplying any secret", async () => {
  let calls = 0
  const access = { list: async () => [], writeFromOperator: async () => { calls++; return undefined }, deleteFromOperator: async () => {} }
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({ language: "ru" })}><ThemeProvider mode="dark" source={emptyThemeSource}><Keymap.Provider><RegistryVault access={access} /></Keymap.Provider></ThemeProvider></ConfigProvider></TestTuiContexts>, { width: 88, height: 18 })
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("+ Добавить запись"))
    const button = app.renderer.root.findDescendantById("registry-vault.add")!
    expect(button.width).toBeGreaterThan(15)
    await app.mockMouse.click(button.x + 2, button.y + 1)
    for (let n = 0; n < 30 && !calls; n++) await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(1)
  } finally { app.renderer.destroy() }
})
