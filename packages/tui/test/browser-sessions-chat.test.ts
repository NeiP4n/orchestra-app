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

test("restart: a stray chat or a chatless copy never makes a second record of the same name", () => {
  const {
    adoptBrowserChat,
    collapseDuplicateChats,
  } = require("../src/util/browser-sessions") as typeof import("../src/util/browser-sessions")
  // The record kept its name but lost its chat bind: the orphan chat of the same name is taken by it, not adopted twice.
  const a = emptyBrowserSessions()
  addBrowserSession(a, "p", { id: "brw_1", now: 1, name: "Browser 4" })
  expect(adoptBrowserChat(a, "p", { id: "brw_x", chat: "ses_1", name: "Browser 4", now: 2 })?.id).toBe("brw_1")
  expect(a.projects.p).toHaveLength(1)
  expect(a.projects.p![0]!.chat).toBe("ses_1")
  // The record already has its own chat: a second chat of that name is not adopted.
  expect(adoptBrowserChat(a, "p", { id: "brw_y", chat: "ses_2", name: "Browser 4", now: 3 })).toBeUndefined()
  expect(a.projects.p).toHaveLength(1)
  // Already saved duplicates: the chatless copy goes, the one with a chat stays and is selected; running it twice changes nothing.
  const b = emptyBrowserSessions()
  addBrowserSession(b, "p", { id: "brw_1", now: 1, name: "Browser 4" })
  const copy = addBrowserSession(b, "p", { id: "brw_2", now: 2, name: "Browser 4" })!
  b.projects.p![0]!.chat = "ses_1"
  expect(b.selected.p).toBe(copy.id)
  expect(collapseDuplicateChats(b)).toBe(1)
  expect(b.projects.p!.map((item) => item.id)).toEqual(["brw_1"])
  expect(b.selected.p).toBe("brw_1")
  expect(collapseDuplicateChats(b)).toBe(0)
  // Chatless older copy and a newer one with a chat: the chat one survives.
  const c = emptyBrowserSessions()
  addBrowserSession(c, "p", { id: "brw_1", now: 1, name: "Browser 4" })
  addBrowserSession(c, "p", { id: "brw_2", now: 2, name: "Browser 4" })
  c.projects.p![1]!.chat = "ses_9"
  collapseDuplicateChats(c)
  expect(c.projects.p!.map((item) => item.id)).toEqual(["brw_2"])
  expect(c.selected.p).toBe("brw_2")
  // Other names stay.
  const d = emptyBrowserSessions()
  addBrowserSession(d, "p", { id: "brw_1", now: 1, name: "Browser 1" })
  addBrowserSession(d, "p", { id: "brw_2", now: 2, name: "Browser 2" })
  expect(collapseDuplicateChats(d)).toBe(0)
})
