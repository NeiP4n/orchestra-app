import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

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
