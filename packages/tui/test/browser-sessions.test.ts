import { expect, test } from "bun:test"
import {
  addBrowserSession,
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
