/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ProjectTemplatesSimple, type ProjectTemplatesAccess } from "../src/component/project-templates-simple"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
for (const width of [80, 120])
  test(`simple template flow at ${width} columns: one confirm, no path fields, details optional`, async () => {
    const calls: string[] = []
    const access: ProjectTemplatesAccess = {
      list: async () => [{ id: "factory", name: "Фабрика" }],
      prepareSave: async () => ({
        token: "save-token",
        name: "Мой проект",
        details: "Точный JSON и проверенные настройки.",
      }),
      prepareCreate: async (id) => {
        expect(id).toBe("factory")
        return { token: "create-token", name: "Фабрика", details: "Детали нового проекта." }
      },
      confirmSave: async (token) => {
        calls.push(token)
      },
      confirmCreate: async (token) => {
        calls.push(token)
      },
    }
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ProjectTemplatesSimple access={access} canSave={true} />
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width, height: 24 },
    )
    app.renderer.start()
    const click = async (id: string) => {
      await app.waitFor(() => !!app.renderer.root.findDescendantById(id))
      const box = app.renderer.root.findDescendantById(id)!
      await app.mockMouse.click(box.x + 1, box.y)
      await app.renderOnce()
    }
    try {
      await app.waitForFrame((f) => f.includes("Фабрика"))
      expect(app.captureCharFrame()).not.toMatch(/staging|SHA256|JSON|Абсолютная|папк/)
      await click("project-templates.save")
      await app.waitForFrame((f) => f.includes("Сохранить «Мой проект»?"))
      expect(calls).toEqual([])
      expect(app.captureCharFrame()).not.toContain("Точный JSON")
      await click("project-templates.details")
      expect(app.captureCharFrame()).toContain("Точный JSON")
      await click("project-templates.confirm")
      await app.waitForFrame((f) => f.includes("Проект сохранён как шаблон"))
      expect(calls).toEqual(["save-token"])
      await click("project-templates.create-factory")
      await app.waitForFrame((f) => f.includes("Создать «Фабрика»?"))
      if (process.env.CAPTURE_SIMPLE_FRAME)
        await Bun.write(process.env.CAPTURE_SIMPLE_FRAME + width, JSON.stringify(app.captureSpans()))
      await click("project-templates.cancel")
      expect(calls).toEqual(["save-token"])
      await click("project-templates.create-factory")
      await app.waitForFrame((f) => f.includes("Создать «Фабрика»?"))
      await click("project-templates.confirm")
      await app.waitForFrame((f) => f.includes("Проект создан"))
      expect(calls).toEqual(["save-token", "create-token"])
    } finally {
      app.renderer.destroy()
    }
  })
