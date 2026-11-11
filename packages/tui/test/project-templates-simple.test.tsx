/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ProjectTemplatesSimple, type ProjectTemplatesAccess } from "../src/component/project-templates-simple"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
for (const width of [80, 120]) for (const version of [1, 2])
  test(`simple template flow v${version} at ${width} columns: one confirm, no path fields, details optional`, async () => {
    const calls: string[] = []
    const access: ProjectTemplatesAccess = {
      list: async () => [{ id: "factory", name: "Фабрика" }],
      prepareSave: async () => ({
        token: "save-token",
        name: "Мой проект",
        details: version === 2 ? JSON.stringify({ format: "orchestra.project-template", version: 2, process: { skills: [] } }) : "Точный JSON и проверенные настройки.",
      }),
      prepareCreate: async (id) => {
        expect(id).toBe("factory")
        return { token: "create-token", name: "Фабрика", details: version === 2 ? JSON.stringify({ format: "orchestra.project-template", version: 2, process: { skills: [] } }) : "Детали нового проекта." }
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
          <ConfigProvider config={createTuiResolvedConfig({ language: "ru" })}>
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
      expect(app.captureCharFrame()).toContain(version === 2 ? '"version":2' : "Точный JSON")
      await click("project-templates.confirm")
      await app.waitForFrame((f) => f.includes("Проект сохранён как шаблон"))
      expect(calls).toEqual(["save-token"])
      await click("project-templates.update-factory")
      await app.waitForFrame(frame => frame.includes("Обновить «Мой проект»"))
      expect(calls).toEqual(["save-token"])
      if (process.env.CAPTURE_SIMPLE_UPDATE && version === 2)
        await Bun.write(process.env.CAPTURE_SIMPLE_UPDATE + width, JSON.stringify(app.captureSpans()))
      await click("project-templates.cancel")
      await click("project-templates.create-factory")
      await app.waitForFrame((f) => f.includes("Создать «Фабрика»?"))
      if (version === 2) {
        expect(app.captureCharFrame()).toContain("Роли, процесс и запасные модели включены.")
        expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain("Навыки старых проектов могут перенестись не полностью")
        expect(app.captureCharFrame()).not.toContain("определения ролей, запасные модели")
      } else expect(app.captureCharFrame()).toContain("не копируются")
      if (process.env.CAPTURE_SIMPLE_FRAME)
        await Bun.write(process.env.CAPTURE_SIMPLE_FRAME + width + (version === 2 ? "-v2" : ""), JSON.stringify(app.captureSpans()))
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

test("confirmation retries the same operation after partial failure and refresh failure never claims create failed", async () => {
  let refreshFails = false,
    firstConfirm = true
  const calls: string[] = []
  const access: ProjectTemplatesAccess = {
    list: async () => {
      if (refreshFails) throw Error("offline")
      return [{ id: "factory", name: "Factory" }]
    },
    prepareSave: async () => ({ token: "save", name: "Factory", details: "" }),
    confirmSave: async () => {},
    prepareCreate: async () => ({ token: "durable-create", name: "Factory", details: "" }),
    confirmCreate: async (token) => {
      calls.push(token)
      if (firstConfirm) {
        firstConfirm = false
        throw Error("partial write")
      }
      refreshFails = true
    },
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ language: "ru" })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <ProjectTemplatesSimple access={access} canSave={true} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24 },
  )
  app.renderer.start()
  const click = async (id: string) => {
    await app.waitFor(() => !!app.renderer.root.findDescendantById(id))
    const node = app.renderer.root.findDescendantById(id)!
    await app.mockMouse.click(node.x + 1, node.y)
    await app.renderOnce()
  }
  try {
    await app.waitForFrame((f) => f.includes("Factory"))
    await click("project-templates.create-factory")
    await app.waitForFrame((f) => f.includes("Создать «Factory»"))
    await click("project-templates.confirm")
    await app.waitForFrame((f) => f.includes("Повторите это же подтверждение"))
    expect(app.renderer.root.findDescendantById("project-templates.confirm")).toBeDefined()
    await click("project-templates.confirm")
    await app.waitForFrame((f) => f.includes("Список пока не обновился"))
    expect(app.captureCharFrame()).toContain("Проект создан")
    expect(app.renderer.root.findDescendantById("project-templates.confirm")).toBeUndefined()
    expect(calls).toEqual(["durable-create", "durable-create"])
    if (process.env.CAPTURE_SIMPLE_FAILURE)
      await Bun.write(process.env.CAPTURE_SIMPLE_FAILURE, JSON.stringify(app.captureSpans()))
  } finally {
    app.renderer.destroy()
  }
})

test("plain Save offers an explicit same-name update and never overwrites before review", async () => {
  const prepared: Array<string | undefined> = [], saved: string[] = []
  let keys: { move: (delta: number) => void; activate: () => void } | undefined
  const access: ProjectTemplatesAccess = {
    list: async () => [{id:"existing",name:"Фабрика"}],
    prepareSave: async (id) => { prepared.push(id); return {token:id ? "update" : "new",name:"Фабрика",details:"Точный новый бандл"} },
    confirmSave: async (token) => { saved.push(token) },
    prepareCreate: async () => {throw Error("must not create")},
    confirmCreate: async () => {throw Error("must not create")},
  }
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({language:"ru"})}><ThemeProvider mode="dark" source={emptyThemeSource}><ProjectTemplatesSimple access={access} canSave={true} keys={(value)=>{keys=value}} /></ThemeProvider></ConfigProvider></TestTuiContexts>,{width:100,height:30})
  app.renderer.start()
  const click = async (id:string) => {
    await app.waitFor(()=>!!app.renderer.root.findDescendantById(id))
    const box=app.renderer.root.findDescendantById(id)!
    await app.mockMouse.click(box.x+1,box.y)
    await app.renderOnce()
  }
  try {
    await app.waitForFrame(frame=>frame.includes("Фабрика"))
    await click("project-templates.save")
    await app.waitForFrame(frame=>frame.includes("Обновить существующий шаблон"))
    expect(app.captureCharFrame()).toContain("Сохранить отдельную копию")
    expect(prepared).toEqual([undefined])
    expect(saved).toEqual([])
    if(process.env.CAPTURE_COLLISION) await Bun.write("/tmp/template-collision.spans.json",JSON.stringify(app.captureSpans()))
    await click("project-templates.replace-existing")
    await app.waitForFrame(frame=>frame.includes("Обновить «Фабрика»"))
    expect(prepared).toEqual([undefined,"existing"])
    expect(saved).toEqual([])
    await click("project-templates.confirm")
    await app.waitForFrame(frame=>frame.includes("Шаблон обновлён"))
    expect(saved).toEqual(["update"])
    expect(keys).toBeDefined()
  } finally {app.renderer.destroy()}
})
