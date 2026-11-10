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
import type { CredentialVault } from "@orchestra/core/credential-vault/index"

for (const columns of [80, 120]) test(`columns=${columns}: actual registry renders empty local/global slots, explicit scope selection and two-click current-chat grant/revoke`, async () => {
  const entries: CredentialVault.SlotInfo[] = [{ id: "local", name: "service", type: "api-key", label: "Service", scope: "project", projectID: "prj_a", state: "empty", allowedSessionIDs: [] }, { id: "global", name: "shared", type: "login", label: "Shared", scope: "global", state: "filled", allowedSessionIDs: [] }]
  const writes: unknown[] = [], grants: string[][] = []
  const access = {
    list: async () => entries.map(({ id, name }) => ({ id, name })), slots: async () => entries.map((v) => ({ ...v, allowedSessionIDs: [...v.allowedSessionIDs] })),
    writeFromOperator: async (_id?: string, _signal?: AbortSignal, _ready?: unknown, initial?: unknown) => { writes.push(initial); return undefined },
    deleteFromOperator: async () => {},
    setAllowedSessionsFromOperator: async (id: string, allowed: string[], confirmed: boolean) => { expect(confirmed).toBe(true); grants.push(allowed); entries.find((v) => v.id === id)!.allowedSessionIDs = allowed },
  }
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode="dark" source={emptyThemeSource}><Keymap.Provider><RegistryVault access={access} projectID="prj_a" sessionID="ses_main" /></Keymap.Provider></ThemeProvider></ConfigProvider></TestTuiContexts>, { width: columns, height: 30 })
  app.renderer.start()
  const click = async (id: string) => { const box = app.renderer.root.findDescendantById(id)!; expect(box).toBeDefined(); await app.mockMouse.click(box.x + 2, box.y + Math.min(1, box.height - 1)); await app.renderOnce() }
  try {
    await app.waitForFrame((f) => f.includes("service · проект · пусто"))
    expect(app.captureCharFrame()).toContain("shared · все проекты")
    expect(app.captureCharFrame()).toContain("Заполнить")
    await click("registry-vault.scope-global")
    await click("registry-vault.add"); await app.waitFor(() => writes.length === 1)
    expect(writes[0]).toEqual({ name: "", site: "", scope: "global" })
    await app.waitForFrame((f) => !f.includes("Ожидание окна"))
    await click("registry-vault.scope-project"); await click("registry-vault.add"); await app.waitFor(() => writes.length === 2)
    expect(writes[1]).toEqual({ name: "", site: "", scope: "project" })
    await app.waitForFrame((f) => !f.includes("Ожидание окна"))
    await click("registry-vault.grant-local"); expect(grants).toEqual([])
    await app.waitForFrame((f) => f.includes("Подтвердить чат?"))
    await click("registry-vault.grant-local"); await app.waitForFrame((f) => f.includes("Отозвать чат"))
    expect(grants).toEqual([["ses_main"]])
    if (process.env.CAPTURE_VAULT_FRAME) { await Bun.write(process.env.CAPTURE_VAULT_FRAME + columns, app.captureCharFrame()); await Bun.write(process.env.CAPTURE_VAULT_FRAME + columns + '.json', JSON.stringify(app.captureSpans())) }
    await click("registry-vault.grant-local"); await app.waitForFrame((f) => !f.includes("Отозвать чат")); expect(grants).toEqual([["ses_main"], []])
  } finally { app.renderer.destroy() }
})
