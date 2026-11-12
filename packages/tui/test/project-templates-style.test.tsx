/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ProjectTemplatesSimple, type ProjectTemplatesKeys } from "../src/component/project-templates-simple"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"

for (const width of [48, 80, 120]) {
  for (const empty of [false, true]) {
    test(`templates show styled actions, hover and selected state at ${width}, empty=${empty}`, async () => {
      const calls: string[] = []
      let keys: ProjectTemplatesKeys | undefined
      const app = await testRender(() => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig({ language: "ru" })}>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ProjectTemplatesSimple canSave={!empty} keys={(value) => { keys = value }} access={{
                list: async () => empty ? [] : [{ id: "factory", name: "Фабрика" }],
                prepareSave: async () => { calls.push("prepare-save"); return { token: "save", name: "Мой проект", details: "Настройки проекта." } },
                prepareCreate: async () => { calls.push("prepare-create"); return { token: "create", name: "Фабрика", details: "Настройки проекта." } },
                confirmSave: async () => { calls.push("confirm-save") },
                confirmCreate: async () => { calls.push("confirm-create") },
              }} />
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ), { width, height: 28 })
      const capture = async (state: string) => {
        if (process.env.CAPTURE_TEMPLATE_STYLE)
          await Bun.write(`${process.env.CAPTURE_TEMPLATE_STYLE}-${width}-${state}.json`, JSON.stringify(app.captureSpans()))
      }
      const background = (text: string) => app.captureSpans().lines.flatMap((row) => row.spans)
        .find((span) => span.text.includes(text))?.bg.toInts()
      app.renderer.start()
      try {
        await app.waitForFrame((frame) => frame.includes("Шаблоны проектов") && !frame.includes("Подготовка"))
        const frame = app.captureCharFrame()
        expect(frame).toContain("[ Сохранить шаблон ]")
        expect(frame).not.toContain("Путь к файлу шаблона")
        expect(frame).toContain("↑↓ выбор · Enter действие")
        await capture(empty ? "empty" : "selected")
        if (empty) {
          expect(frame).not.toContain("Откройте проект")
          expect(frame).toContain("Шаблонов пока нет")
          keys!.activate()
          keys!.move(1)
          keys!.activate()
          const disabled = app.renderer.root.findDescendantById("project-templates.save")!
          await app.mockMouse.click(disabled.x + 2, disabled.y)
          expect(calls).toEqual([])
          return
        }
        const create = app.renderer.root.findDescendantById("project-templates.create-factory")!
        const before = background("[ Фабрика · Создать ]")
        await app.mockMouse.moveTo(create.x + 3, create.y)
        await app.renderOnce()
        expect(background("[ Фабрика · Создать ]")).not.toEqual(before)
        await capture("hover")
        await app.mockMouse.moveTo(width - 1, 27)
        keys!.move(1)
        await app.renderOnce()
        expect(app.captureCharFrame()).toContain("› [ Фабрика · Создать ]")
        await capture("keyboard")
        keys!.activate()
        await app.waitForFrame((f) => f.includes("Создать «Фабрика»?"))
        expect(calls).toEqual(["prepare-create"])
        expect(app.captureCharFrame()).toContain("› [ Создать ]")
        await capture("confirm")
        keys!.move(1)
        keys!.activate()
        await app.renderOnce()
        expect(calls).toEqual(["prepare-create"])
      } finally { app.renderer.destroy() }
    })
  }
}


test("compact no-project import and single-line library at 48 columns", async () => {
  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({language:"ru"})}><ThemeProvider mode="dark" source={emptyThemeSource}>
      <ProjectTemplatesSimple canSave={false} access={{list:async () => [{id:"test",name:"Test2"}],prepareSave:async()=>{throw Error("disabled")},confirmSave:async()=>{},prepareCreate:async()=>({token:"t",name:"Test2",details:"Reviewed"}),confirmCreate:async()=>{},prepareImport:async()=>({token:"i",name:"Friend",details:"Reviewed"}),confirmImport:async()=>{}}}/>
    </ThemeProvider></ConfigProvider></TestTuiContexts>
  ),{width:48,height:16})
  app.renderer.start()
  try {
    await app.waitForFrame(f => f.includes("Test2"))
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("Откройте проект")
    expect(frame).not.toContain("Вставьте полный путь")
    expect(frame.split("\n").some(line => line.includes("Test2") && line.includes("Создать"))).toBe(true)
    if(process.env.CAPTURE_TEMPLATE_STYLE) await Bun.write(`${process.env.CAPTURE_TEMPLATE_STYLE}-import.json`,JSON.stringify(app.captureSpans()))
  } finally {app.renderer.destroy()}
})
