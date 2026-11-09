import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { activeBrowserSession, selectBrowserSession, emptyBrowserSessions } from "../src/util/browser-sessions"

test("switching selected profiles wins over the BrowserAgent chat still open", () => {
  const state = emptyBrowserSessions()
  const planner = { id: "brw_planner", name: "Planner Browser Watcher", chat: "chat_planner", created: 1 }
  const whatsapp = { id: "brw_whatsapp", name: "WhatsApp", chat: "chat_whatsapp", created: 2 }
  state.projects.test = [planner, whatsapp]
  const selected = () => state.projects.test!.find((item) => item.id === state.selected.test)
  selectBrowserSession(state, "test", planner.id)
  expect(activeBrowserSession(selected(), planner)).toBe(planner)
  selectBrowserSession(state, "test", whatsapp.id)
  expect(activeBrowserSession(selected(), planner)).toBe(whatsapp)
  expect(activeBrowserSession(selected(), planner)?.chat).toBe("chat_whatsapp")
  selectBrowserSession(state, "test", planner.id)
  expect(activeBrowserSession(selected(), whatsapp)).toBe(planner)
  expect(activeBrowserSession(undefined, whatsapp)).toBe(whatsapp)
  expect(state.projects.test).toEqual([planner, whatsapp])
})

test("frame uses selected profile, direct chat sync, and a keyed pane; launch selects its profile", () => {
  const frame = readFileSync(new URL("../src/component/session-frame.tsx", import.meta.url), "utf8")
  const start = frame.indexOf("const browserSession =")
  const resolver = frame.slice(start, frame.indexOf("// The chat agent", start))
  expect(resolver).toContain("return activeBrowserSession(project ? notes.browserSelected(project.id)")
  expect(resolver).not.toContain("return bound.item")
  expect(frame).toContain("notes.selectBrowserSession(bound.projectID, bound.item.id)")
  expect(frame).toMatch(/<Show\s+keyed\s+when=\{browserSession\(\)\}/)
  expect(frame).toContain("sessionID={item.id}")
  const tree = readFileSync(new URL("../src/component/project-tree.tsx", import.meta.url), "utf8")
  const begin = tree.indexOf("const toggleBrowser =")
  const toggle = tree.slice(begin, tree.indexOf("const [browserBatchProgress", begin))
  expect(toggle).toContain("notes.selectBrowserSession(project.id, id)")
  expect(toggle).toContain('notes.setTab("browser")')
  expect(toggle).toContain("BrowserRuntime.closeBlockedBrowser(id)")
})
