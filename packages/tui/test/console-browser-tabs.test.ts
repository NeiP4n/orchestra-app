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
  expect(frame).toMatch(/visible=\{!fullscreen\(\) && !centerView\(\)\}/)
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
