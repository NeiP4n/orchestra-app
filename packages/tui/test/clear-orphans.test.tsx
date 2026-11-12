/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ClearOrphansAction } from "../src/component/clear-orphans"
import { ClearSessionsAction } from "../src/component/clear-sessions"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

for (const language of ["en", "ru"] as const) for (const width of [48, 80]) test(`orphan cleanup confirms backend count in ${language}/${width}`, async () => {
  let confirmed = 0
  const messages: string[] = [], notices: string[] = []
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({ language })}><ThemeProvider mode="dark" source={emptyThemeSource}><box width={32}>
    <ClearSessionsAction api={{ list: async () => ({ data: [], cursor: {} }), remove: async () => {} }} confirm={async () => false} notify={() => {}} leaveCurrentSession={() => {}} />
    <ClearOrphansAction local api={{ prepare: async () => ({ token: "server-preview", count: 2, definition: "missing parent" }), confirm: async ({ token }) => { expect(token).toBe("server-preview"); confirmed++; return { removed: 1, skipped: 1, deleted: ["ses_deleted"] } } }} confirm={async options => { messages.push(options.message); return true }} notify={options => notices.push(options.message)} />
  </box></ThemeProvider></ConfigProvider></TestTuiContexts>, { width, height: 10 })
  app.renderer.start()
  try {
    const label = language === "ru" ? "Очистить сироты" : "Clear orphans"
    await app.waitForFrame(frame => frame.includes(label))
    expect(app.captureCharFrame()).toContain(language === "ru" ? "Очистить все сессии" : "Clear all sessions")
    if (process.env.CAPTURE_ORPHANS) await Bun.write(`${process.env.CAPTURE_ORPHANS}-${language}-${width}.json`, JSON.stringify(app.captureSpans()))
    const action = app.renderer.root.findDescendantById("project-tree.clear-orphans.action")!
    await app.mockMouse.click(action.x, action.y)
    for (let attempt = 0; !notices.length && attempt < 100; attempt++) await Bun.sleep(10)
    expect(confirmed).toBe(1)
    expect(messages[0]).toContain("2")
    expect(notices[0]).toContain("1")
  } finally { app.renderer.destroy() }
})

test("cancel and remote view never delete", async () => {
  for (const local of [true, false]) {
    let removed = 0
    const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode="dark" source={emptyThemeSource}><ClearOrphansAction local={local} api={{ prepare: async () => ({ token: "preview", count: 2, definition: "" }), confirm: async () => { removed++; return { removed: 2, skipped: 0, deleted: [] } } }} confirm={async () => false} notify={() => {}} /></ThemeProvider></ConfigProvider></TestTuiContexts>, { width: 48, height: 10 })
    app.renderer.start()
    try {
      await Bun.sleep(30)
      const action = app.renderer.root.findDescendantById("project-tree.clear-orphans.action")
      if (local) { expect(action).toBeDefined(); await app.mockMouse.click(action!.x, action!.y); await Bun.sleep(30) }
      else expect(action).toBeUndefined()
      expect(removed).toBe(0)
    } finally { app.renderer.destroy() }
  }
})

test("an old server capability blocks cleanup before the first mutation", async () => {
  let calls = 0
  const notices: string[] = []
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode="dark" source={emptyThemeSource}><ClearOrphansAction local supported={() => false} api={{ prepare: async () => { calls++; throw new Error("must not call") }, confirm: async () => { calls++; throw new Error("must not call") } }} confirm={async () => true} notify={o => notices.push(o.message)} /></ThemeProvider></ConfigProvider></TestTuiContexts>, { width: 48, height: 10 })
  app.renderer.start()
  try {
    await app.waitForFrame(f => f.includes("Clear orphans"))
    const node = app.renderer.root.findDescendantById("project-tree.clear-orphans.action")!
    await app.mockMouse.click(node.x, node.y)
    await app.waitFor(() => notices.length > 0)
    expect(notices[0]).toContain("Update and restart")
    expect(calls).toBe(0)
  } finally { app.renderer.destroy() }
})
