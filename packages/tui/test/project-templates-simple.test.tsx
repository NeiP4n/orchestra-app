/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Keymap } from "../src/context/keymap"
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

for(const width of [80,120]) test(`unavailable role save uses one visible warning and explicit consent at ${width}`,async()=>{
 const calls:unknown[][]=[]
 const access:ProjectTemplatesAccess={
  list:async()=>[],
  prepareSave:async()=>({token:"missing-role",name:"Test2",details:JSON.stringify({format:"orchestra.project-template",version:2,sessions:[{title:"Old worker",role:"team_deleted"}],process:{skills:[],unresolvedRoles:["team_deleted"]}}),unresolvedRoles:["team_deleted"]}),
  confirmSave:async(...args)=>{calls.push(args)},prepareCreate:async()=>{throw Error("not create")},confirmCreate:async()=>{throw Error("not create")},
 }
 const app=await testRender(()=><TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({language:"ru"})}><ThemeProvider mode="dark" source={emptyThemeSource}><ProjectTemplatesSimple access={access} canSave /></ThemeProvider></ConfigProvider></TestTuiContexts>,{width,height:40})
 app.renderer.start()
 const click=async(id:string)=>{
  await app.waitFor(()=>!!app.renderer.root.findDescendantById(id))
  const box=app.renderer.root.findDescendantById(id)!
  await app.mockMouse.click(box.x+1,box.y);await app.renderOnce()
 }
 try{
  await app.waitForFrame(f=>f.includes("Шаблонов пока нет")&&!f.includes("Подготовка"))
  await click("project-templates.save")
  await app.waitForFrame(f=>f.includes("Сохранить неполный шаблон"))
  const frame=app.captureCharFrame().replace(/\s+/g," ")
  expect(frame).toContain("Создание проекта заблокировано")
  expect(frame).toContain("правила и назначения навыков сохранятся")
  expect(calls).toEqual([])
  if(process.env.CAPTURE_ROLE_REVIEW)await Bun.write(`/tmp/template-role-review-${width}.spans.json`,JSON.stringify(app.captureSpans()))
  await click("project-templates.details")
  expect(app.captureCharFrame()).toContain("Недоступная роль: team_deleted")
  expect(app.captureCharFrame()).toContain("Сессия Old worker: роль team_deleted")
  if(process.env.CAPTURE_ROLE_REVIEW)await Bun.write(`/tmp/template-role-details-${width}.spans.json`,JSON.stringify(app.captureSpans()))
  await click("project-templates.confirm")
  await app.waitForFrame(f=>f.includes("Проект сохранён как шаблон"))
  expect(calls).toEqual([["missing-role",false,false,true]])
 }finally{app.renderer.destroy()}
})

test("file export shows exact project-root path and git warning",async()=>{
 const calls:string[]=[]
 const access:ProjectTemplatesAccess={list:async()=>[{id:"demo",name:"Test2"}],prepareSave:async()=>{throw Error("not save")},confirmSave:async()=>{},prepareCreate:async()=>{throw Error("not create")},confirmCreate:async()=>{},
  copyPath:async file=>{calls.push("copy:"+file)},openFolder:async file=>{calls.push("open:"+file)},
  exportFile:async id=>{calls.push(id);return{path:"C:/Projects/Test2/Test2.orchestra-template",warning:"Do not commit to git"}},
 }
 const app=await testRender(()=><TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({language:"ru"})}><ThemeProvider mode="dark" source={emptyThemeSource}><ProjectTemplatesSimple access={access} canSave /></ThemeProvider></ConfigProvider></TestTuiContexts>,{width:100,height:30})
 app.renderer.start()
 try{
  await app.waitForFrame(f=>f.includes("Экспорт"))
  const box=app.renderer.root.findDescendantById("project-templates.export-demo")!
  await app.mockMouse.click(box.x+1,box.y)
  await app.waitForFrame(f=>f.includes("C:/Projects/Test2/Test2.orchestra-template"))
  expect(app.captureCharFrame().replace(/\s+/g," ")).toContain("Не добавляйте этот файл в git")
  expect(app.captureCharFrame()).toContain("Отправьте этот файл другу")
  for(const action of ["copy-path","open-folder"]){
    const node=app.renderer.root.findDescendantById("project-templates."+action)!
    await app.mockMouse.click(node.x+1,node.y)
    await app.renderOnce()
  }
  expect(calls).toEqual(["demo","copy:C:/Projects/Test2/Test2.orchestra-template","open:C:/Projects/Test2/Test2.orchestra-template"])
  if(process.env.CAPTURE_TRANSFER)await Bun.write("/tmp/template-transfer.spans.json",JSON.stringify(app.captureSpans()))
 }finally{app.renderer.destroy()}
})

test("import path receives keyboard focus and terminal paste, and clicking restores focus", async () => {
  let keys: import("../src/component/project-templates-simple").ProjectTemplatesKeys | undefined
  const imported: string[] = []
  function Navigation() {
    Keymap.createLayer(() => ({ mode: "base", commands: [
      { bind: "down", title: "Next", run: () => keys?.move(1) },
      { bind: "up", title: "Previous", run: () => keys?.move(-1) },
      { bind: "return", title: "Import", run: () => keys?.activate() },
    ] }))
    Keymap.createLayer(() => ({ mode: "base", enabled: () => keys?.input() !== undefined, target: () => keys?.input() }))
    return null
  }
  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({ language: "ru" })}><ThemeProvider mode="dark" source={emptyThemeSource}><Keymap.Provider><Navigation />
      <ProjectTemplatesSimple canSave={true} keys={value => { keys = value }} access={{
        list: async () => [], prepareSave: async () => { throw Error("not used") }, confirmSave: async () => {}, prepareCreate: async () => { throw Error("not used") }, confirmCreate: async () => {},
        prepareImport: async file => { imported.push(file); return { token: "review", name: "Импорт", details: "reviewed" } },
      }} />
    </Keymap.Provider></ThemeProvider></ConfigProvider></TestTuiContexts>
  ), { width: 100, height: 24 })
  app.renderer.start()
  try {
    await app.waitForFrame(frame => frame.includes("Путь к файлу"))
    app.mockInput.pressArrow("down")
    await app.renderOnce()
    expect(app.renderer.currentFocusedEditor?.id).toBe("project-templates.import-path")
    await app.mockInput.pasteBracketedText('  "C:\\My Folder\\friend.orchestra-template"  ')
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("friend.orchestra-template")
    await Bun.write("/tmp/template-input-focused-spans.json", JSON.stringify(app.captureSpans()))
    app.mockInput.pressArrow("down")
    await app.renderOnce()
    expect(app.renderer.currentFocusedEditor?.id).not.toBe("project-templates.import-path")
    const input = app.renderer.root.findDescendantById("project-templates.import-path")!
    await app.mockMouse.click(input.x + 1, input.y)
    await app.renderOnce()
    expect(app.renderer.currentFocusedEditor?.id).toBe("project-templates.import-path")
    app.mockInput.pressEnter()
    await app.waitFor(() => imported.length === 1)
    expect(imported[0]).toBe('  "C:\\My Folder\\friend.orchestra-template"  ')
    await app.waitForFrame(frame => frame.includes("Импорт"))
    await Bun.write("/tmp/template-input-spans.json", JSON.stringify(app.captureSpans()))
  } finally { app.renderer.destroy() }
})
