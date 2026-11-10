import { onCleanup } from "solid-js"
import { Keymap } from "../src/context/keymap"
/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { RegistryPanel } from "../src/component/devtools-registry"
import { tmpdir } from "./fixture/fixture"
import { ProjectsProvider } from "../src/context/projects"
import { NotesProvider } from "../src/context/notes"
import { renderLocal } from "./fixture/local"
import { json, directory } from "./fixture/tui-client"

for (const templateID of ["factory", "process:factory"])
  test(`mounted connected screen uses generated HTTP actions and strictly persists reserved browser identities before completion (${templateID})`, async () => {
  await using temporary = await tmpdir()
  const calls: string[] = [],
    manifest = {
      importID: "pti_import",
      projectID: "prj_new",
      createdAt: 1,
      browsers: [{ id: "brw_import", name: "Inbox", chat: "ses_import", mode: "window" }],
    }
  await using app = await renderLocal({
    language: "ru",
    fetch: async (url, request) => {
      if (url.pathname === "/api/orchestra/project")
        return json([{ id: "prj_source", name: "Factory", directory, main: "ses_main" }])
      if (url.pathname === "/api/orchestra/owner") return json({ ses_main: "prj_source" })
      if (url.pathname === "/api/orchestra/project-template/prj_source/browsers") return json(null)
      if (url.pathname === "/api/orchestra/project-template") return json([{ id: templateID, name: "Factory" }])
      if (url.pathname === "/api/orchestra/project-template/prepare-save") {
        const body = await request.json()
        expect(body.projectID).toBe("prj_source")
        expect(body.browsers).toEqual([])
        calls.push("prepare-save")
        return json({ token: "pts_saved", name: "Factory", details: "Config only" })
      }
      if (url.pathname === "/api/orchestra/project-template/confirm-save") {
        expect((await request.json()).token).toBe("pts_saved")
        calls.push("confirm-save")
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/orchestra/project-template/prepare-create") {
        const body = await request.json()
        expect(body.templateID).toBe(templateID)
        expect(body.settingsDirectory).toBe(directory)
        calls.push("prepare-create")
        return json({ token: "pti_import", name: "Factory", details: templateID.startsWith("process:") ? JSON.stringify({ format: "orchestra.project-template", version: 2, process: { skills: [] } }) : "Config only" })
      }
      if (url.pathname === "/api/orchestra/project-template/confirm-create") {
        expect((await request.json()).token).toBe("pti_import")
        calls.push("confirm-create")
        return json({ projectID: "prj_new", mainSessionID: "ses_new_main", browsers: manifest })
      }
      if (url.pathname === "/api/orchestra/project-template/finish-create") {
        expect((await request.json()).token).toBe("pti_import")
        calls.push("finish-create")
        return new Response(null, { status: 204 })
      }
      return undefined
    },
    view: () => {
      // Match the actual Registry dialog's modal keyboard scope.
      const pop = Keymap.use().mode.push("modal")
      onCleanup(pop)
      return (
      <ProjectsProvider>
        <NotesProvider>
          <RegistryPanel options={{ probe: () => true, terminalProbe: () => true, directory: temporary.path }} />
        </NotesProvider>
      </ProjectsProvider>
      )
    },
  })
  app.route.navigate({ type: "session", sessionID: "ses_main" })
  app.renderer.start()
  const click = async (id: string) => {
    await app.waitFor(() => !!app.renderer.root.findDescendantById(id))
    const node = app.renderer.root.findDescendantById(id)!
    await app.mockMouse.click(node.x + 1, node.y)
    await app.renderOnce()
  }
  await app.waitForFrame((f) => f.includes("Шаблоны"))
  const lines = app.captureCharFrame().split("\n"),
    tabRow = lines.findIndex((line) => line.includes("Шаблоны"))
  await app.mockMouse.click(lines[tabRow].indexOf("Шаблоны") + 1, tabRow)
  await app.waitForFrame((f) => f.includes("Factory"))
  await click("project-templates.save")
  await app.waitForFrame((f) => f.includes("Сохранить «Factory»"))
  expect(calls).toEqual(["prepare-save"])
  await click("project-templates.confirm")
  await app.waitForFrame((f) => f.includes("Проект сохранён"))
  // The registry owns the modal key layer: keyboard selection must reach the mounted templates screen.
  app.mockInput.pressArrow("down")
  await app.renderOnce()
  app.mockInput.pressEnter()
  await app.waitForFrame((f) => f.includes("Создать «Factory»"))
  expect(calls).not.toContain("confirm-create")
  if (templateID.startsWith("process:")) expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain("Навыки старых проектов могут перенестись не полностью")
  if (process.env.CAPTURE_CONNECTED_CONFIRM && templateID.startsWith("process:")) await Bun.write(process.env.CAPTURE_CONNECTED_CONFIRM, JSON.stringify(app.captureSpans()))
  await click("project-templates.confirm")
  await app.waitForFrame((f) => f.includes("Проект создан"))
  expect(calls).toEqual(["prepare-save", "confirm-save", "prepare-create", "confirm-create", "finish-create"])
  const stored = JSON.parse(await readFile(path.join(app.state, "test/tui/browser-sessions.json"), "utf8"))
  expect(stored.projects.prj_new[0]).toMatchObject({
    id: "brw_import",
    chat: "ses_import",
    mode: "window",
    templateImportID: "pti_import",
  })
  expect(stored.selected.prj_new).toBeUndefined()
  if (process.env.CAPTURE_CONNECTED_FRAME)
    await Bun.write(process.env.CAPTURE_CONNECTED_FRAME, JSON.stringify(app.captureSpans()))
})
