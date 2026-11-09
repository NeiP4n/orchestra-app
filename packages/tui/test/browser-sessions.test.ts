import { expect, test } from "bun:test"
import {
  addBrowserSession,
  adoptBrowserChat,
  bindBrowserChat,
  browserChatRecord,
  isBrowserChat,
  browserSessionGroups,
  emptyBrowserSessions,
  forgetClosedBrowserSession,
  groupBrowserSession,
  MAX_BROWSER_SESSIONS,
  removeBrowserSession,
  reopenBrowserSession,
  renameBrowserSession,
  selectBrowserSession,
} from "../src/util/browser-sessions"

test("sessions are added per project, named in order, and the newest is selected", () => {
  const state = emptyBrowserSessions()
  addBrowserSession(state, "p1", { id: "a", now: 1 })
  addBrowserSession(state, "p1", { id: "b", now: 2 })
  addBrowserSession(state, "p2", { id: "c", now: 3 })
  expect(state.projects.p1?.map((item) => item.name)).toEqual(["Browser 1", "Browser 2"])
  expect(state.projects.p2?.map((item) => item.name)).toEqual(["Browser 1"])
  expect(state.selected).toEqual({ p1: "b", p2: "c" })
})

test("removing a middle session never makes two share a name", () => {
  const state = emptyBrowserSessions()
  for (const id of ["a", "b", "c"]) addBrowserSession(state, "p", { id, now: 0 })
  removeBrowserSession(state, "p", "a")
  addBrowserSession(state, "p", { id: "d", now: 0 })
  const names = state.projects.p!.map((item) => item.name)
  expect(new Set(names).size).toBe(names.length)
})

test("removing the selected session selects its neighbour, and the last one leaves none", () => {
  const state = emptyBrowserSessions()
  for (const id of ["a", "b", "c"]) addBrowserSession(state, "p", { id, now: 0 })
  removeBrowserSession(state, "p", "c")
  expect(state.selected.p).toBe("b")
  removeBrowserSession(state, "p", "b")
  removeBrowserSession(state, "p", "a")
  expect(state.selected.p).toBeUndefined()
})

test("selecting an unknown session is ignored", () => {
  const state = emptyBrowserSessions()
  addBrowserSession(state, "p", { id: "a", now: 0 })
  selectBrowserSession(state, "p", "missing")
  expect(state.selected.p).toBe("a")
})

test("a project holds at most the limit", () => {
  const state = emptyBrowserSessions()
  for (let i = 0; i < MAX_BROWSER_SESSIONS; i++)
    expect(addBrowserSession(state, "p", { id: `s${i}`, now: 0 })).toBeDefined()
  expect(addBrowserSession(state, "p", { id: "over", now: 0 })).toBeUndefined()
})

test("sessions group by name, ungrouped first", () => {
  const state = emptyBrowserSessions()
  for (const id of ["a", "b", "c"]) addBrowserSession(state, "p", { id, now: 0 })
  groupBrowserSession(state, "p", "b", "Docs")
  groupBrowserSession(state, "p", "c", "Docs")
  const groups = browserSessionGroups(state.projects.p!)
  expect(groups.map((group) => [group.name, group.sessions.map((item) => item.id)])).toEqual([
    [undefined, ["a"]],
    ["Docs", ["b", "c"]],
  ])
  groupBrowserSession(state, "p", "b")
  expect(browserSessionGroups(state.projects.p!).length).toBe(2)
  expect(state.projects.p![1]!.group).toBeUndefined()
})

test("renaming changes only the label: the id that keys the Chrome profile stays", () => {
  const state = emptyBrowserSessions()
  addBrowserSession(state, "p", { id: "brw_x1", now: 1 })
  expect(renameBrowserSession(state, "p", "brw_x1", "  Work account  ")).toBe(true)
  expect(state.projects.p?.[0]).toEqual({ id: "brw_x1", name: "Work account", created: 1 })
  expect(renameBrowserSession(state, "p", "brw_x1", "   ")).toBe(false)
  expect(renameBrowserSession(state, "p", "missing", "x")).toBe(false)
  expect(state.projects.p?.[0]?.name).toBe("Work account")
})

test("a removed session is kept aside and reopens with its own id and name", () => {
  const state = emptyBrowserSessions()
  addBrowserSession(state, "p", { id: "a", now: 1, name: "Shop", group: "Work" })
  addBrowserSession(state, "p", { id: "b", now: 2 })
  removeBrowserSession(state, "p", "a")
  expect(state.projects.p?.map((item) => item.id)).toEqual(["b"])
  expect(state.closed?.p?.map((item) => item.id)).toEqual(["a"])
  // Another session now takes the number the closed one never had; the closed one keeps its own name.
  addBrowserSession(state, "p", { id: "c", now: 3, name: "Shop" })
  const back = reopenBrowserSession(state, "p", "a")
  expect(back).toEqual({ id: "a", name: "Shop", group: "Work", created: 1 })
  expect(state.projects.p?.map((item) => item.id)).toEqual(["b", "c", "a"])
  expect(state.closed?.p).toEqual([])
  expect(state.selected.p).toBe("a")
})

test("reopening something that is not closed, or past the limit, does nothing", () => {
  const state = emptyBrowserSessions()
  expect(reopenBrowserSession(state, "p", "x")).toBeUndefined()
  addBrowserSession(state, "p", { id: "a", now: 1 })
  removeBrowserSession(state, "p", "a")
  for (let n = 0; n < MAX_BROWSER_SESSIONS; n++) addBrowserSession(state, "p", { id: `s${n}`, now: n })
  expect(reopenBrowserSession(state, "p", "a")).toBeUndefined()
  expect(state.closed?.p?.map((item) => item.id)).toEqual(["a"])
})

test("forgetting a closed session removes it from the list and leaves the open ones alone", () => {
  const state = emptyBrowserSessions()
  for (const id of ["a", "b", "c"]) addBrowserSession(state, "p", { id, now: 0 })
  removeBrowserSession(state, "p", "a")
  removeBrowserSession(state, "p", "b")
  forgetClosedBrowserSession(state, "p", "a")
  expect(state.closed?.p?.map((item) => item.id)).toEqual(["b"])
  expect(state.projects.p?.map((item) => item.id)).toEqual(["c"])
  forgetClosedBrowserSession(state, "other", "x")
})

test("forgotten and history-evicted BrowserAgent chats never resurrect through adoption", () => {
  const state = emptyBrowserSessions()
  addBrowserSession(state, "p", { id: "a", now: 1, name: "Old browser" })
  bindBrowserChat(state, "p", "a", "old-chat")
  removeBrowserSession(state, "p", "a")
  forgetClosedBrowserSession(state, "p", "a")
  const restored = JSON.parse(JSON.stringify(state))
  expect(adoptBrowserChat(restored, "p", { id: "new", chat: "old-chat", name: "Old browser", now: 2 })).toBeUndefined()
  expect(restored.projects.p).toEqual([])
  // A brand new chat still gets adopted; tombstones do not ban a label forever.
  expect(adoptBrowserChat(restored, "p", { id: "fresh", chat: "new-chat", name: "Old browser", now: 3 })).toBeDefined()
})

test("closed history eviction does not let old browser chats return", () => {
  const state = emptyBrowserSessions()
  for (let n = 0; n < 35; n++) {
    addBrowserSession(state, "p", { id: String(n), now: n })
    bindBrowserChat(state, "p", String(n), `chat-${n}`)
    removeBrowserSession(state, "p", String(n))
  }
  expect(state.closed?.p?.length).toBe(30)
  expect(adoptBrowserChat(state, "p", { id: "resurrected", chat: "chat-0", name: "old", now: 50 })).toBeUndefined()
  const closed = state.closed!.p![0]!
  expect(reopenBrowserSession(state, "p", closed.id)?.chat).toBe(closed.chat)
})

test("explicit reopen keeps original browser identity after JSON roundtrip of tombstones", () => {
  const state = emptyBrowserSessions()
  addBrowserSession(state, "p", { id: "same-profile", name: "Work", now: 1 })
  bindBrowserChat(state, "p", "same-profile", "same-chat")
  removeBrowserSession(state, "p", "same-profile")
  const restored = JSON.parse(JSON.stringify(state))
  expect(adoptBrowserChat(restored, "p", { id: "other", name: "Work", chat: "same-chat", now: 2 })).toBeUndefined()
  expect(reopenBrowserSession(restored, "p", "same-profile")?.chat).toBe("same-chat")
  expect(restored.selected.p).toBe("same-profile")
})


test("browser identity survives a changed working directory and role without re-creating a profile", () => {
  const state = emptyBrowserSessions()
  addBrowserSession(state, "stable-project", { id: "stable-profile", name: "Work", now: 1 })
  bindBrowserChat(state, "stable-project", "stable-profile", "stable-chat")
  const restored = JSON.parse(JSON.stringify(state))
  const bound = browserChatRecord(restored, "stable-chat")
  expect(bound?.projectID).toBe("stable-project")
  expect(bound?.item.id).toBe("stable-profile")
  expect(isBrowserChat("custom-reader", bound !== undefined)).toBe(true)
  expect(isBrowserChat("team-browser-registration-agent", false)).toBe(true)
  expect(isBrowserChat("orchestrator", false)).toBe(false)
  removeBrowserSession(restored, "stable-project", "stable-profile")
  expect(browserChatRecord(restored, "stable-chat")?.closed).toBe(true)
  expect(adoptBrowserChat(restored, "stable-project", { id: "wrong-new-profile", name: "Work", chat: "stable-chat", now: 2 })).toBeUndefined()
  expect(reopenBrowserSession(restored, "stable-project", "stable-profile")?.id).toBe("stable-profile")
})

test("deleted BrowserAgent chat retires active binding but preserves profile ID in closed history", async () => {
  const { retireDeletedBrowserChat, showInGeneralNetwork } = await import("../src/util/browser-sessions")
  const state = emptyBrowserSessions()
  addBrowserSession(state, "p", { id: "saved-profile", now: 1 })
  bindBrowserChat(state, "p", "saved-profile", "deleted-chat")
  retireDeletedBrowserChat(state, "deleted-chat")
  expect(state.projects.p).toHaveLength(0)
  expect(state.closed?.p?.[0]?.id).toBe("saved-profile")
  expect(state.closed?.p?.[0]?.chat).toBeUndefined()
  expect(state.retiredChats?.p).toContain("deleted-chat")
  expect(showInGeneralNetwork({ id: "old", title: "Browser 4" }, false)).toBe(false)
  expect(showInGeneralNetwork({ id: "new", title: "WhatsApp" }, true)).toBe(false)
  expect(showInGeneralNetwork({ id: "work", title: "Build" }, false)).toBe(true)
})
