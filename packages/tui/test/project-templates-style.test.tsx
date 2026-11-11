/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ProjectTemplatesSimple, type ProjectTemplatesKeys } from "../src/component/project-templates-simple"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"

for (const width of [80, 120]) {
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
        await app.waitForFrame((frame) => frame.includes("Сохранённые шаблоны") && !frame.includes("Подготовка"))
        const frame = app.captureCharFrame()
        expect(frame).toContain("[ Сохранить проект как шаблон ]")
        expect(frame).toContain("[ Создать проект из шаблона ]")
        expect(frame).toContain("↑↓ выбор · Enter действие")
        await capture(empty ? "empty" : "selected")
        if (empty) {
          expect(frame).toContain("Откройте проект")
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
        const before = background("[ Создать проект из шаблона ]")
        await app.mockMouse.moveTo(create.x + 3, create.y)
        await app.renderOnce()
        expect(background("[ Создать проект из шаблона ]")).not.toEqual(before)
        await capture("hover")
        await app.mockMouse.moveTo(width - 1, 27)
        keys!.move(1)
        await app.renderOnce()
        expect(app.captureCharFrame()).toContain("› [ Создать проект из шаблона ]")
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
