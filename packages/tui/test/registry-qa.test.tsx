/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { renderLocal } from "./fixture/local"
import { json } from "./fixture/tui-client"
import { RegistryPanel } from "../src/component/devtools-registry"
import { ProjectsProvider } from "../src/context/projects"
import { NotesProvider } from "../src/context/notes"
for (const width of [48, 120])
  test(`Registry command handler exposes MCP at ${width}`, async () => {
    await using app = await createAppFixture({
      width,
      height: 32,
      config: { animations: false, debug: { devtools: true } },
    })
    await app.ready
    await app.waitForFrame((f) => f.includes("Ask anything"))
    await app.mockInput.pressKey("p", { ctrl: true })
    await app.waitForFrame((f) => f.includes("All ·") && f.includes("Search") && f.includes("tab category"))
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.mockInput.typeText("Open tool registry")
    await app.renderOnce()
    await app.mockInput.pressKey("RETURN")
    await app.waitForFrame((f) => f.includes("MCP") && f.includes("Context7"))
    expect(app.captureCharFrame()).toContain("Templates")
    await Bun.write(`/tmp/registry-command-${width}.json`, JSON.stringify(app.captureSpans()))
    // Registry uses the same modal scope as other dialogs. Base-mode
    // navigation shortcuts do not replace an open modal implicitly.
    await app.mockInput.pressKey("p", { ctrl: true })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Templates")
    expect(app.captureCharFrame()).not.toContain("tab category")
    await app.mockInput.pressKey("ESCAPE")
    await app.waitForFrame(f => f.includes("Ask anything"))
    await app.mockInput.pressKey("p", { ctrl: true })
    await app.waitForFrame(f => f.includes("tab category"))
  })
for (const width of [48, 120])
  test(`long imported template details remain inside Registry scroll at ${width}`, async () => {
    const details = JSON.stringify(
      {
        format: "fixture",
        rows: Array.from({ length: 150 }, (_, i) => ({ i, text: "Long safe template details ".repeat(4) })),
      },
      null,
      2,
    )
    await using app = await renderLocal({
      width,
      height: 32,
      fetch: async (url, req) => {
        if (url.pathname === "/api/orchestra/project-template") return json([])
        if (url.pathname.endsWith("/prepare-import")) return json({ token: "preview", name: "Long template", details })
      },
    })
    app.dialog.replace(
      () => (
        <ProjectsProvider>
          <NotesProvider>
            <RegistryPanel options={{ probe: () => true, terminalProbe: () => true }} />
          </NotesProvider>
        </ProjectsProvider>
      ),
      undefined,
      { size: "large" },
    )
    app.dialog.setCentered(true)
    await app.waitForFrame((f) => f.includes("Templates"))
    const click = async (id: string) => {
      const n = app.renderer.root.findDescendantById(id)!
      await app.mockMouse.click(n.x + 1, n.y)
      await app.renderOnce()
    }
    let lines = app.captureCharFrame().split("\n"),
      y = lines.findIndex((l) => l.includes("Templates"))
    await app.mockMouse.click(lines[y].indexOf("Templates") + 1, y)
    await app.waitForFrame((f) => f.includes("Project templates"))
    const input = app.renderer.root.findDescendantById("project-templates.import-path") as any
    input.focus()
    await app.mockInput.typeText("/tmp/fixture.orchestra-template")
    input.blur()
    await app.renderOnce()
    await click("project-templates.import")
    await app.waitForFrame((f) => f.includes("Long template"))
    await click("project-templates.details")
    await app.renderOnce()
    await app.renderOnce()
    expect(
      app
        .captureCharFrame()
        .split("\n")
        .some((l) => l.includes("Registry") && l.includes("esc")),
    ).toBe(true)
    expect(app.captureCharFrame()).toContain("Templates")
    const node = app.renderer.root.findDescendantById("project-templates.details-json")!
    expect(node.height).toBeGreaterThan(32)
    expect(node.y).toBeGreaterThan(y)
    await Bun.write(`/tmp/registry-long-details-${width}.json`, JSON.stringify(app.captureSpans()))
    const scroll = app.renderer.root.findDescendantById("registry.body") as any
    scroll.scrollTo(scroll.scrollHeight)
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Registry")
    expect(app.captureCharFrame()).toContain("149")
    await Bun.write(`/tmp/registry-long-bottom-${width}.json`, JSON.stringify(app.captureSpans()))
  })

test("bar-opened Templates hides underlying project labels at 120", async () => {
  await using app = await createAppFixture({
    width: 120,
    height: 32,
    config: { animations: false, debug: { devtools: true } },
    fetch: (url) => {
      if (url.pathname === "/api/orchestra/project")
        return json([{ id: "prj_demo", name: "UNDERLAY_PROJECT_SENTINEL", directory: "/tmp/demo", created: 0 }])
      if (url.pathname === "/api/orchestra/project-template") return json([])
    },
  })
  await app.ready
  await app.waitForFrame((f) => f.includes("Registry"))
  const click = async (text: string) => {
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findIndex((l) => l.includes(text))
    expect(y).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(lines[y].indexOf(text) + 2, y)
  }
  await click(" Registry ")
  await app.waitForFrame((f) => f.includes("Templates"))
  await click("Templates")
  await app.waitForFrame((f) => f.includes("Project templates"))
  await app.renderOnce()
  expect(app.captureCharFrame()).not.toContain("UNDERLAY_PROJECT_SENTINEL")
  await Bun.write("/tmp/registry-bar-120.json", JSON.stringify(app.captureSpans()))
})
