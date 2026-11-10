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
    await app.waitForFrame((f) => f.includes(text("Could not finish. Nothing was replaced. Try again.")))
    if (process.env.CAPTURE_TEMPLATE_ERRORS) await Bun.write(`${process.env.CAPTURE_TEMPLATE_ERRORS}-${language}.json`, JSON.stringify(app.captureSpans()))
    expect(app.captureCharFrame()).not.toContain("private diagnostic")
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain(text("Template storage is not writable. Check application data folder permissions."))
    if (language === "en") expect(app.captureCharFrame()).not.toMatch(/[А-Яа-яЁё]/)
  } finally { app.renderer.destroy() }
})
