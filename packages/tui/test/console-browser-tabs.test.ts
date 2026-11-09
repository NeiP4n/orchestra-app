import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { adoptBrowserChat, collapseDuplicateChats, emptyBrowserSessions } from "../src/util/browser-sessions"

const read = (file: string) => readFileSync(path.join(import.meta.dir, "..", "src", file), "utf8")

test("the left panel offers Console and Browser tabs that wrap on a narrow panel", () => {
  const tree = read("component/project-tree.tsx")
  expect(tree).toMatch(/tab="console"/)
  expect(tree).toMatch(/tab="browser"/)
  expect(tree).toMatch(/flexDirection="row" flexWrap="wrap"/)
  expect(read("context/notes.tsx")).toMatch(/NotesTab = "projects" \| "notes" \| "console" \| "browser"/)
})

test("the Console and Browser tabs replace the center chat, Projects restores it", () => {
  const frame = read("component/session-frame.tsx")
  expect(frame).toMatch(/notes\.tab\(\) === "console" \|\| notes\.tab\(\) === "browser"/)
  expect(frame).toMatch(/visible=\{!fullscreen\(\) && !hidesChat\(\)\}/)
  expect(frame).toMatch(/id="center-view"/)
})

test("Console and Browser are translated", () => {
  const base = read("util/i18n-base.ts")
  expect(base).toMatch(/Console: "Консоль"/)
  expect(base).toMatch(/Browser: "Браузер"/)
})

test("the session frame defines every terminal helper it reads", () => {
  const frame = read("component/session-frame.tsx")
  for (const name of ["selectedTerminal", "consoleTerminal", "consoleSessions", "centerView", "session"]) {
    expect(frame).toMatch(new RegExp(`const ${name} = `))
  }
})

test("the hidden right pane is remembered across sessions and the chat is unmounted behind Console", () => {
  const frame = read("component/session-frame.tsx")
  expect(frame).toMatch(/rightPaneHidden\?: boolean/)
  expect(frame).toMatch(/const rightPaneHidden = \(\) => layout\.rightPaneHidden === true/)
  expect(frame).not.toMatch(/const \[rightPaneHidden, setRightPaneHidden\] = createSignal/)
  expect(frame).toMatch(/<Show when=\{!hidesChat\(\)\}>\s*<InteractivityProvider/)
})

test("the Browser view moves to the BrowserAgent chat only when it opens or the selection changes, not whenever the open chat changes", () => {
  const frame = read("component/session-frame.tsx")
  expect(frame).toMatch(/on\(\s*\(\) => \[centerView\(\), browserSession\(\)\?\.chat\] as const/)
  expect(frame).toContain("untrack(() => props.sessionID)")
})

test("the view follows the chat that opens: BrowserAgent chat to Browser, any other chat to Projects", () => {
  const frame = read("component/session-frame.tsx")
  expect(frame).toContain('info.agent === "team-browser-agent"')
  expect(frame).toContain('notes.setTab("browser")')
  expect(frame).toContain('notes.setTab("projects")')
  expect(frame).toMatch(/on\(\s*\(\) => props\.sessionID,/)
})

test("the project tree lists subagents (sessions with a parent) under their parent with role and status", () => {
  const tree = read("component/project-tree.tsx")
  expect(tree).toContain("item.parentID === parentID")
  expect(tree).toContain("childRows(project.main)")
  expect(tree).toContain("childRows(session.id)")
})

test("the project tree refetches categories when an open project's session set changes", () => {
  const tree = read("component/project-tree.tsx")
  expect(tree).toContain("const refresh = (projectID: string)")
  expect(tree).toContain("setTimeout(() => refresh(project.id)")
})

test("a subagent whose parent is not listed is listed as a session of its own, and nesting is recursive", () => {
  const tree = read("component/project-tree.tsx")
  expect(tree).toContain("orphan(session.parentID, project)")
  expect(tree).toContain("childRows(child.id, depth + 1)")
})

test("every project tree has a Browsers group with its browser sessions, orphan BrowserAgent chats and New browser session", () => {
  const tree = read("component/project-tree.tsx")
  expect(tree).toMatch(/t\("Browsers"\)/)
  expect(tree).toContain("browserChatsOf(project)")
  expect(tree.match(/\{browserRows\(project\)\}/g)?.length).toBe(2)
})

test("deleting a chat or removing a browser session cleans the Browser tab: no pointer to a gone chat, no foreign chat beside the page", () => {
  expect(read("component/project-tree.tsx")).toContain("notes.forgetBrowserChat(sessionID)")
  expect(read("util/browser-sessions.ts")).toContain("export function forgetBrowserChat")
  expect(read("component/session-frame.tsx")).toContain("A chat no browser session owns")
})

test("a browser session row in the Browsers group opens only its chat from Projects, and the view follow-up leaves the tab", () => {
  const tree = read("component/project-tree.tsx")
  expect(tree).toContain("openedFromProjects.add(item.chat)")
  expect(tree).not.toContain('notes.setTab("browser")')
  expect(read("component/session-frame.tsx")).toContain("openedFromProjects.delete(id)")
})

test("every browser-role session, subagents and custom browser roles included, is listed in the Browsers group", () => {
  const tree = read("component/project-tree.tsx")
  expect(tree).toContain("/browser/i.test(agent)")
  expect(tree).toContain("ownedByBrowserRecord(project, session.id)")
  expect(tree).toContain("!isBrowserRole(item.agent)")
})

test("every session row in the tree (subagents, BrowserAgent chats, plain sessions) has rename and delete", () => {
  const tree = read("component/project-tree.tsx")
  expect(tree.match(/\{rowButtons\((?:child|chat)\)\}/g)?.length).toBe(2)
  expect(tree.match(/session-rename:\$\{session\.id\}/g)?.length).toBeGreaterThanOrEqual(2)
})

test("row buttons are three cells wide so the hover highlight sits on the glyph, and any browser-like session lands in Browsers", () => {
  const tree = read("component/project-tree.tsx")
  expect(tree).not.toContain('{" ✎"}')
  expect(tree).not.toContain('" ×"')
  expect(tree).toContain("const isBrowserSession")
  expect(tree).toContain("/browser/i.test(session.title")
})

test("category headers, Browsers included, fold their rows with a remembered state and a count", () => {
  const tree = read("component/project-tree.tsx")
  expect(tree).toContain("notes.toggleGroup(`${project.id}:Browsers`)")
  expect(tree).toContain("notes.toggleGroup(`${project.id}:${group.name}`)")
  expect(read("context/notes.tsx")).toContain("groupCollapsed")
})

test("a browser chat the Orchestrator made becomes a browser session once, keeping the selection", () => {
  const state = emptyBrowserSessions()
  state.projects.p = [{ id: "a", name: "One", created: 1 }]
  state.selected.p = "a"
  const made = adoptBrowserChat(state, "p", { id: "b", chat: "ses_1", name: "Muse регистрация", now: 2 })
  expect(made).toMatchObject({ id: "b", chat: "ses_1", name: "Muse регистрация" })
  expect(state.selected.p).toBe("a")
  expect(adoptBrowserChat(state, "p", { id: "c", chat: "ses_1", name: "Again", now: 3 })).toBeUndefined()
  expect(state.projects.p).toHaveLength(2)
})

test("the browser pane draws its own tab strip and address from the runtime's tabs", () => {
  const pane = read("component/browser-pane.tsx")
  for (const name of ["BrowserRuntime.tabs(", "BrowserRuntime.selectTab(", "BrowserRuntime.closeTab(", "BrowserRuntime.newTab(", "BrowserRuntime.go(", "BrowserRuntime.history("])
    expect(pane).toContain(name)
  expect(pane.indexOf("tabList()")).toBeLessThan(pane.indexOf("<browserImage"))
})

test("the button's session and the Orchestrator's chat each give exactly one record per chat", () => {
  // Orchestrator path: the same orphan chat seen twice is adopted once.
  const state = emptyBrowserSessions()
  expect(adoptBrowserChat(state, "p", { id: "a", chat: "ses_1", name: "One", now: 1 })).toBeDefined()
  expect(adoptBrowserChat(state, "p", { id: "b", chat: "ses_1", name: "One", now: 2 })).toBeUndefined()
  expect(state.projects.p).toHaveLength(1)
  // Button path: a record that got its chat, then a second record adopted for the same chat before the bind landed.
  const both = emptyBrowserSessions()
  both.projects.p = [
    { id: "btn", name: "Browser 1", created: 1, chat: "ses_2" },
    { id: "dup", name: "Browser 1", created: 2, chat: "ses_2" },
    { id: "other", name: "Other", created: 3, chat: "ses_3" },
    { id: "nochat", name: "Fresh", created: 4 },
  ]
  both.selected.p = "dup"
  expect(collapseDuplicateChats(both)).toBe(1)
  expect(both.projects.p.map((item) => item.id)).toEqual(["btn", "other", "nochat"])
  expect(both.selected.p).toBe("btn")
  expect(collapseDuplicateChats(both)).toBe(0)
})

test("a chat is claimed the moment it is created, before its binding lands, so adoption never takes it", () => {
  const notes = read("context/notes.tsx")
  expect(notes.indexOf("claimed.add(created.id)")).toBeGreaterThan(0)
  expect(notes.indexOf("claimed.add(created.id)")).toBeLessThan(notes.indexOf("await created.request"))
  expect(notes).toContain("if (claimed.has(chat)) return")
  expect(read("component/project-tree.tsx")).toContain("!notes.claimedChat(session.id)")
})
