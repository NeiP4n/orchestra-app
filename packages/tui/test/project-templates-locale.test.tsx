/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { testRender } from "@opentui/solid"
import { ProjectTemplatesSimple } from "../src/component/project-templates-simple"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { translate } from "../src/util/i18n"
import { registryEn, registryRu } from "../src/util/i18n-registry"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"

test("Registry EN/RU keys and placeholders match exactly", () => {
  expect(Object.keys(registryRu).sort()).toEqual(Object.keys(registryEn).sort())
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((row) => row[1]).sort()
  for (const key of Object.keys(registryEn) as (keyof typeof registryEn)[]) {
    expect(placeholders(registryRu[key])).toEqual(placeholders(registryEn[key]))
    expect(translate("en", key)).toBe(registryEn[key])
    expect(translate("ru", key)).toBe(registryRu[key])
  }
})
test("Templates contain no Russian-only UI or raw text labels", async () => {
  const source = await readFile(new URL("../src/component/project-templates-simple.tsx", import.meta.url), "utf8")
  expect(source).not.toMatch(/[А-Яа-яЁё]/)
  expect(source).not.toMatch(/label="[A-Za-z]/)
  expect(source).not.toMatch(/<text\b[^>]*>\s*[A-Za-z][A-Za-z ]+\s*</)
  const messages = [...source.matchAll(/setMessage\("([^"]+)"\)/g)].map((row) => row[1])
  for (const key of messages) expect(key in registryEn).toBe(true)
})
for (const language of ["en", "ru"] as const) test(`template labels, confirmation and errors follow ${language}`, async () => {
  const text = (key: string) => translate(language, key)
  let fail = false
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({ language })}>
    <ThemeProvider mode="dark" source={emptyThemeSource}><ProjectTemplatesSimple canSave access={{
      list: async () => [],
      prepareSave: async () => { if (fail) throw Object.assign(Error("private diagnostic"), { _tag: "InvalidRequestError", kind: "TEMPLATE_PERMISSION" }); return { token: "preview", name: "Factory", details: "{}" } },
      confirmSave: async () => {}, prepareCreate: async () => { throw Error("unused") }, confirmCreate: async () => {},
    }} /></ThemeProvider></ConfigProvider></TestTuiContexts>, { width: 80, height: 26 })
  app.renderer.start()
  const click = async (id: string) => { const node = app.renderer.root.findDescendantById(`project-templates.${id}`)!; await app.mockMouse.click(node.x + 2, node.y); await app.renderOnce() }
  try {
    await app.waitForFrame((f) => f.includes(text("Project templates")))
    expect(app.captureCharFrame()).toContain(text("No templates yet. Save a project above."))
    await click("save")
    await app.waitForFrame((f) => f.includes(text("Settings only, without chats, data or secrets.")))
    if (process.env.CAPTURE_TEMPLATE_LOCALE) await Bun.write(`${process.env.CAPTURE_TEMPLATE_LOCALE}-${language}.json`, JSON.stringify(app.captureSpans()))
    await click("cancel")
    fail = true
    await click("save")
    await app.waitForFrame((f) => f.includes(text("Template storage is not writable. Check application data folder permissions.").split(".")[0]))
    if (process.env.CAPTURE_TEMPLATE_ERRORS) await Bun.write(`${process.env.CAPTURE_TEMPLATE_ERRORS}-${language}.json`, JSON.stringify(app.captureSpans()))
    expect(app.captureCharFrame()).not.toContain("private diagnostic")
    expect(app.captureCharFrame()).not.toContain(text("Could not finish. Nothing was replaced. Try again."))
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain(text("Template storage is not writable. Check application data folder permissions."))
    if (language === "en") expect(app.captureCharFrame()).not.toMatch(/[А-Яа-яЁё]/)
  } finally { app.renderer.destroy() }
})

for (const language of ["en", "ru"] as const) test(`blocked browser links have explicit redacted save choice in ${language}`, async () => {
  const text = (key: string) => translate(language, key)
  const calls: unknown[] = []
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({ language })}>
    <ThemeProvider mode="dark" source={emptyThemeSource}><ProjectTemplatesSimple canSave access={{
      list: async () => [], prepareSave: async () => ({ token: "review", name: "Factory", details: "Safe configuration only.", omittedLinks: [{ browser: 1, link: 2, reason: "query" }, { browser: 1, link: 3, reason: "local" }], triggerReview: [{ schedule: 1, browser: 1, reason: "browser-links-omitted" }, { schedule: 2, reason: "time-review" }] }),
      confirmSave: async (...args) => { calls.push(args) }, prepareCreate: async () => { throw Error("unused") }, confirmCreate: async () => {},
    }} /></ThemeProvider></ConfigProvider></TestTuiContexts>, { width: 90, height: 34 })
  app.renderer.start()
  const click = async (id: string) => { const node = app.renderer.root.findDescendantById(`project-templates.${id}`)!; await app.mockMouse.click(node.x + 2, node.y); await app.renderOnce() }
  try {
    await app.waitForFrame((f) => f.includes(text("Project templates")))
    await click("save")
    await app.waitForFrame((f) => f.includes(text("Save without blocked links")))
    expect(calls).toEqual([])
    await click("details")
    await app.waitForFrame((f) => f.includes(text("Query parameters may contain private data")))
    expect(app.captureCharFrame()).not.toContain("PRIVATE_CANARY")
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain(text("Skills, role definitions, model fallback lists, project files and global MCP settings are not copied. Review destination configuration."))
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain(text("Some links were omitted; choose page/chat and sign in again; starts paused."))
    expect(app.captureCharFrame()).not.toContain(text("Could not finish. Nothing was replaced. Try again."))
    await Bun.write(`/tmp/template-links-${language}-spans.json`, JSON.stringify(app.captureSpans()))
    await click("cancel")
    expect(calls).toEqual([])
    await click("save")
    await app.waitForFrame((f) => f.includes(text("Save without blocked links")))
    await click("confirm")
    await app.waitForFrame((f) => f.includes(text("Project saved as a template. Chats, data and secrets were not saved.")))
    expect(calls).toEqual([["review", true]])
  } finally { app.renderer.destroy() }
})

for (const width of [80,120]) test(`stale browser chat requires visible review and consent at ${width} columns`, async () => {
  const calls: unknown[]=[]
  const app=await testRender(()=><TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({language:"ru"})}><ThemeProvider mode="dark" source={emptyThemeSource}><ProjectTemplatesSimple canSave access={{
    list:async()=>[],prepareSave:async()=>({token:"binding-review",name:"Test2",details:JSON.stringify({format:"orchestra.project-template",version:2,process:{skills:[]}}),browserBindings:[{browser:1,reason:"missing"},{browser:2,reason:"foreign"}]}),
    confirmSave:async(...args)=>{calls.push(args)},prepareCreate:async()=>{throw Error("unused")},confirmCreate:async()=>{},
  }}/></ThemeProvider></ConfigProvider></TestTuiContexts>,{width,height:38})
  app.renderer.start()
  const click=async(id:string)=>{const node=app.renderer.root.findDescendantById(`project-templates.${id}`)!;await app.mockMouse.click(node.x+2,node.y);await app.renderOnce()}
  try {
    await app.waitForFrame(f=>f.includes("Шаблоны проектов"));await click("save")
    await app.waitForFrame(f=>f.includes("Браузер 1:"))
    const frame=app.captureCharFrame().replace(/\s+/g," ")
    expect(frame).toContain("Браузер 2: старая привязка к чату недоступна.")
    expect(frame).toContain("Исходный проект не меняется.")
    expect(calls).toEqual([])
    if(process.env.CAPTURE_BROWSER_BINDING_REVIEW) await Bun.write(`${process.env.CAPTURE_BROWSER_BINDING_REVIEW}-${width}.json`,JSON.stringify(app.captureSpans()))
    await click("cancel");expect(calls).toEqual([])
    await click("save");await app.waitForFrame(f=>f.includes("Браузер 1:"));await click("confirm")
    await app.waitForFrame(f=>f.includes("Проект сохранён как шаблон"))
    expect(calls).toEqual([["binding-review",false,true]])
  }finally{app.renderer.destroy()}
})

for (const width of [48,80,120]) test(`create shows one actual safe cause without repeated generic failure at ${width}`, async () => {
 const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({language:"ru"})}><ThemeProvider mode="dark" source={emptyThemeSource}><ProjectTemplatesSimple canSave={false} access={{list:async()=>[{id:"demo",name:"Test2"}],prepareSave:async()=>{throw Error("unused")},confirmSave:async()=>{},prepareCreate:async()=>{throw Object.assign(Error("PRIVATE_CANARY"),{_tag:"InvalidRequestError",kind:"TEMPLATE_MODEL"})},confirmCreate:async()=>{}}}/></ThemeProvider></ConfigProvider></TestTuiContexts>,{width,height:18})
 app.renderer.start()
 try {
  await app.waitForFrame(f=>f.includes("Test2"))
  const node=app.renderer.root.findDescendantById("project-templates.create-demo")!
  await app.mockMouse.click(node.x+2,node.y)
  await app.waitForFrame(f=>f.includes("модель недоступна"))
  const frame=app.captureCharFrame()
  expect(frame).not.toContain("Не получилось завершить")
  expect(frame).not.toContain("PRIVATE_CANARY")
  expect(frame.match(/модель недоступна/g)).toHaveLength(1)
  await Bun.write(`/tmp/template-actual-cause-${width}.json`,JSON.stringify(app.captureSpans()))
 } finally {app.renderer.destroy()}
})

for (const width of [48,80,120]) test(`core migration requires a visible review and confirmation ${width}`,async()=>{
 let creates=0,migrations=0
 const app=await testRender(()=><TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({language:"ru"})}><ThemeProvider mode="dark" source={emptyThemeSource}><ProjectTemplatesSimple canSave={false} access={{list:async()=>[{id:"old",name:"Test2",digest:"a".repeat(64)},{id:"new",name:"Test2",digest:"b".repeat(64)}],prepareSave:async()=>{throw Error("unused")},confirmSave:async()=>{},prepareCreate:async()=>{throw Object.assign(Error("private"),{_tag:"InvalidRequestError",kind:"TEMPLATE_CORE_ROLE"})},prepareMigration:async()=>{migrations++;return{token:"reviewed",name:"Test2",details:JSON.stringify({format:"orchestra.project-template",version:2,process:{skills:[],roles:[]},sessions:[]}),roleChanges:[{role:"orchestrator",fields:["rules"],fromHash:"a".repeat(64),toHash:"c".repeat(64)}]}},confirmCreate:async token=>{expect(token).toBe("reviewed");creates++}}}/></ThemeProvider></ConfigProvider></TestTuiContexts>,{width,height:28})
 app.renderer.start()
 const click=async(id:string)=>{const n=app.renderer.root.findDescendantById("project-templates."+id)!;await app.mockMouse.click(n.x+1,n.y);await app.renderOnce()}
 try{
  await app.waitForFrame(f=>f.includes("#aaaaaaaa")&&f.includes("#bbbbbbbb"))
  await click("create-old");await app.waitForFrame(f=>f.includes("Встроенные роли"))
  expect(creates).toBe(0)
  await click("migrate-core");await app.waitForFrame(f=>f.includes("sha256")&&f.includes("cccccccccccc"))
  expect(creates).toBe(0);expect(migrations).toBe(1)
  await Bun.write(`/tmp/core-migration-review-${width}.json`,JSON.stringify(app.captureSpans()))
  await click("confirm");await app.waitForFrame(f=>f.includes("Проект создан"));expect(creates).toBe(1)
 }finally{app.renderer.destroy()}
})

for(const width of [48,80])test(`template removal asks and keeps source files at ${width}`,async()=>{
 let removed=0
 const app=await testRender(()=><TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({language:"ru"})}><ThemeProvider mode="dark" source={emptyThemeSource}><ProjectTemplatesSimple canSave={false} access={{list:async()=>removed?[]:[{id:"a",name:"Test2",digest:"a".repeat(64)}],prepareSave:async()=>{throw Error("unused")},confirmSave:async()=>{},prepareCreate:async()=>{throw Error("unused")},confirmCreate:async()=>{},remove:async(id,digest)=>{expect(id).toBe("a");expect(digest).toBe("a".repeat(64));removed++}}}/></ThemeProvider></ConfigProvider></TestTuiContexts>,{width,height:18})
 app.renderer.start()
 const click=async(id:string)=>{const n=app.renderer.root.findDescendantById("project-templates."+id)!;await app.mockMouse.click(n.x+1,n.y);await app.renderOnce()}
 try{
  await app.waitForFrame(f=>f.includes("Test2"));await click("remove-a")
  await app.waitForFrame(f=>f.includes("экспортированные"));expect(removed).toBe(0)
  await Bun.write(`/tmp/template-remove-confirm-${width}.json`,JSON.stringify(app.captureSpans()))
  await click("cancel-remove");expect(removed).toBe(0)
  await click("remove-a");await click("confirm-remove")
  await app.waitForFrame(f=>f.includes("Шаблон убран"));expect(removed).toBe(1)
 }finally{app.renderer.destroy()}
})

for(const width of [48,80,120,160])test(`template destination keyboard field and reviewed folder at ${width}`,async()=>{
 let keys:any,received:string|undefined
 const app=await testRender(()=><TestTuiContexts><ConfigProvider config={createTuiResolvedConfig({language:"ru"})}><ThemeProvider mode="dark" source={emptyThemeSource}><ProjectTemplatesSimple canSave={false} keys={value=>{keys=value}} access={{list:async()=>[{id:"a",name:"Test2"}],prepareSave:async()=>{throw Error("unused")},confirmSave:async()=>{},prepareCreate:async(_,destination)=>{received=destination;return {token:"x",name:"Test2",details:"{}",directory:(destination||"/default")+"/pti_fresh"}},confirmCreate:async()=>{}}}/></ThemeProvider></ConfigProvider></TestTuiContexts>,{width,height:24})
 app.renderer.start()
 const click=async(id:string)=>{const n=app.renderer.root.findDescendantById("project-templates."+id)!;await app.mockMouse.click(n.x+1,n.y);await app.renderOnce()}
 try{
  await app.waitForFrame(f=>f.includes("Test2"))
  await click("create-a");await app.waitForFrame(f=>f.includes("pti_fresh"));expect(received).toBe("")
  await click("cancel");keys.move(1);keys.activate();expect(keys.input()?.focused).toBe(true)
  app.mockInput.typeText("/home/user/My Projects");await app.renderOnce()
  await Bun.write(`/tmp/template-destination-input-${width}.json`,JSON.stringify(app.captureSpans()))
  await click("create-a");await app.waitForFrame(f=>f.includes("pti_fresh"));expect(received).toBe("/home/user/My Projects")
  expect(app.captureCharFrame()).toContain("Папка проекта:")
  await Bun.write(`/tmp/template-destination-review-${width}.json`,JSON.stringify(app.captureSpans()))
 }finally{app.renderer.destroy()}
})
