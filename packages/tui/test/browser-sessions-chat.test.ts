import { expect, test } from "bun:test"
import {
  addBrowserSession,
  bindBrowserChat,
  emptyBrowserSessions,
  removeBrowserSession,
  reopenBrowserSession,
} from "../src/util/browser-sessions"

test("one browser session keeps one BrowserAgent chat, also after it is closed and reopened", () => {
  const state = emptyBrowserSessions()
  const session = addBrowserSession(state, "p", { id: "brw_1", now: 1 })!
  expect(bindBrowserChat(state, "p", session.id, "ses_a")).toBe(true)
  expect(bindBrowserChat(state, "p", session.id, "ses_b")).toBe(false)
  expect(state.projects.p![0]!.chat).toBe("ses_a")
  removeBrowserSession(state, "p", session.id)
  expect(state.projects.p).toEqual([])
  expect(reopenBrowserSession(state, "p", session.id)?.chat).toBe("ses_a")
})
