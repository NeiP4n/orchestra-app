/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ConfigProvider } from "../src/config"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { RegistryTemplates } from "../src/component/registry-templates"
import { ProjectTemplateLibrary } from "@orchestra/core/project-template-library"
import { ProjectTemplateFiles } from "@orchestra/core/project-template-files"
import { ProjectTemplate } from "@orchestra/core/project-template"
import { ThemeProvider } from "../src/context/theme"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"

test("operator UI previews actual manifest, requires review, remembers, stages inactive and exports without replacing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-registry-")),
    project = path.join(root, "project")
  await mkdir(project)
  const bundle: ProjectTemplate.Bundle = {
    format: "orchestra.project-template",
    version: 1,
    name: "Demo factory",
    description: "No data",
    minOrchestraVersion: "1.0.0",
    variables: { projectName: "Factory", folder: "${projectFolder}" },
    vault: { local: [{ name: "service", type: "api-key", label: "Service" }], globalRequirements: [] },
    sessions: [],
    browsers: [],
    rules: [],
    schedules: [],
    providers: [],
    mcp: [],
  }
  const preview = ProjectTemplate.preview(JSON.stringify(bundle))
  if (!preview.ok) throw Error()
  const source = await ProjectTemplateFiles.save(root, "source", preview.value.text, preview.value.digest)
  const library = ProjectTemplateLibrary.local(root)
  let scroll: ScrollBoxRenderable | undefined
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <scrollbox width={120} height={36} ref={(s) => (scroll = s)}>
              <RegistryTemplates library={library} version="1.0.0" />
            </scrollbox>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 36 },
  )
  app.renderer.start()
  const locate = async (id: string) => {
    await app.waitFor(() => !!app.renderer.root.findDescendantById(id))
    scroll!.scrollChildIntoView(id)
    await app.renderOnce()
    return app.renderer.root.findDescendantById(id)!
  }
  const click = async (id: string) => {
    const node = await locate(id)
    await app.mockMouse.click(node.x + 2, node.y)
    await app.renderOnce()
  }
  const input = async (id: string, value: string) => {
    const node = (await locate(id)) as InputRenderable
    node.focus()
    app.mockInput.pressKey("a", { ctrl: true })
    await app.mockInput.typeText(value)
    node.blur()
    await app.renderOnce()
  }
  try {
    await locate("registry-templates.source")
    await input("registry-templates.source", source.directory)
    await click("registry-templates.read")
    await locate("registry-templates.review")
    await input("registry-templates.name", "factory")
    await click("registry-templates.remember")
    expect(await library.list()).toEqual([])
    await click("registry-templates.review")
    await click("registry-templates.remember")
    await app.waitFor(() => !!app.renderer.root.findDescendantById("registry-templates.stage"))
    expect((await library.list())[0].name).toBe("factory")
    expect((await library.preview("factory")).digest).toBe(preview.value.digest)
    await input("registry-templates.staging", project)
    await click("registry-templates.review")
    await click("registry-templates.stage")
    await locate("registry-templates.message")
    await app.waitForFrame((f) => f.includes("Это только staging"))
    expect(await readdir(path.join(project, ".orchestra", "template-imports", "factory"))).toEqual(["template.json"])
    expect(await readdir(project)).toEqual([".orchestra"])
    await input("registry-templates.destination", root)
    await click("registry-templates.review")
    await click("registry-templates.export")
    await locate("registry-templates.message")
    await app.waitForFrame((f) => f.includes("Передача другим людям не выполнена"))
    expect(await readFile(path.join(root, "factory", "template.json"), "utf8")).toBe(preview.value.text)
    if (process.env.CAPTURE_TEMPLATE_FRAME) {
      await Bun.write(process.env.CAPTURE_TEMPLATE_FRAME, JSON.stringify(app.captureSpans()))
      scroll!.scrollTo(0)
      await app.renderOnce()
      await Bun.write(process.env.CAPTURE_TEMPLATE_FRAME + ".top", JSON.stringify(app.captureSpans()))
    }
    await input("registry-templates.name", "changed")
    await writeFile(
      path.join(root, "project-templates", "factory", "template.json"),
      JSON.stringify({ ...bundle, name: "Changed source" }),
    )
    await click("registry-templates.review")
    await click("registry-templates.export")
    await locate("registry-templates.message")
    await app.waitForFrame((f) => f.includes("Операция не завершена"))
    expect(await Bun.file(path.join(root, "changed", "template.json")).exists()).toBe(false)
  } finally {
    app.renderer.destroy()
    await rm(root, { recursive: true, force: true })
  }
})
