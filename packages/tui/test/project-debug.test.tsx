import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { ProjectDebug } from "@orchestra/core/session/project-debug"

const cases = ["orchestra", "vesper"].flatMap(theme => ["en", "ru"].flatMap(language => [48, 80, 120, 160].map(width => ({ theme, language: language as "en" | "ru", width, unavailable: false }))))
cases.push({ theme: "vesper", language: "ru", width: 48, unavailable: true }, { theme: "vesper", language: "ru", width: 160, unavailable: true })
for (const { theme, language, width, unavailable } of cases) test(`project recording is readable in ${theme}/${language} at ${width}${unavailable ? " (old backend)" : ""}`, async () => {
  await using state = await tmpdir()
  const directory = state.path
  const session = { id: "ses_debug", title: "Debug test", projectID: "project", location: { directory }, agent: "build", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 } }
  await using app = await createAppFixture({ width, height: 36, state: directory, args: { sessionID: session.id }, config: { theme: { name: theme, mode: "dark" }, language, animations: false, session: { sidebar: "hide" }, debug: { devtools: true } }, fetch: async (url, request) => {
    if (url.pathname === "/api/orchestra/project/prj_debug/debug") {
      if (unavailable) return json({ error: "Not found" }, { status: 404 })
      if (request.method === "PUT") {
        const enabled = (await request.json()).enabled
        await ProjectDebug.setEnabled(directory, enabled)
        if (enabled) await ProjectDebug.record(directory, { timestamp: Date.now(), sessionID: session.id, role: "system", eventType: "project.debug.started", data: { message: "Recording enabled" } })
      }
      return json(await ProjectDebug.status(directory))
    }
    if (url.pathname === "/api/orchestra/project") return json([{ id: "prj_debug", name: "Debug", directory, created: 0, main: session.id }])
    if (url.pathname.endsWith("/prj_debug/browsers")) return json(null)
    if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
    if (url.pathname === "/api/orchestra/owner") return json({ [session.id]: "prj_debug" })
    if (url.pathname === "/api/location") return json({ directory, project: { id: "project", directory, canonical: directory } })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === "/api/session") return json({ data: [session] })
    if (url.pathname === "/api/room/mesh") return json({ _tag: "ServiceUnavailableError", message: "off" }, { status: 503 })
  } })
  await app.ready
  const off = language === "ru" ? "Дебаг ВЫКЛ" : "Debug OFF"
  const rec = language === "ru" ? "REC дебаг" : "REC debug"
  const toggleOff = language === "ru" ? "Запись проекта: ВЫКЛ" : "Project recording: OFF"
  const toggleOn = language === "ru" ? "Запись проекта: ВКЛ" : "Project recording: ON"
  if (unavailable) {
    await app.waitForFrame(frame => frame.includes("REC ошибка"))
    await app.mockMouse.click(app.captureCharFrame().split("\n").find(line => line.includes("REC ошибка"))!.indexOf("REC ошибка") + 1, app.captureCharFrame().split("\n").findIndex(line => line.includes("REC ошибка")))
    await app.waitForFrame(frame => frame.includes("Запись недоступна"))
    expect(app.captureCharFrame()).not.toContain("Запись проекта: ВКЛ")
    expect(await ProjectDebug.enabled(directory)).toBe(false)
    if (process.env.CAPTURE_PROJECT_DEBUG) await Bun.write(`${process.env.CAPTURE_PROJECT_DEBUG}-old-backend-${width}.json`, JSON.stringify(app.captureSpans()))
    return
  }
  await app.waitForFrame(frame => frame.includes(off))
  const click = async (text: string) => {
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findIndex(line => line.includes(text))
    if (y < 0) throw Error("missing action: " + text + "\n" + lines.join("\n"))
    await app.mockMouse.click(lines[y].indexOf(text) + 1, y)
  }
  await click(off)
  await app.waitForFrame(frame => frame.includes(toggleOff))
  expect(await ProjectDebug.enabled(directory)).toBe(false)
  await click(toggleOff)
  await app.waitForFrame(frame => frame.includes(rec))
  expect(await ProjectDebug.enabled(directory)).toBe(true)
  await app.mockInput.pressKey("ESCAPE")
  await app.waitForFrame(frame => frame.includes(rec) && !frame.includes(toggleOn))
  const spans = app.captureSpans()
  const indicator = spans.lines.flatMap(line => line.spans).find(span => span.text.includes(rec))
  expect(indicator).toBeDefined()
  const luminance = (color: NonNullable<typeof indicator>["fg"]) => [0, 1, 2].map(index => color.buffer[index] / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  const light = luminance(indicator!.fg), dark = luminance(indicator!.bg)
  expect((Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)).toBeGreaterThanOrEqual(4.5)
  if (process.env.CAPTURE_PROJECT_DEBUG) await Bun.write(`${process.env.CAPTURE_PROJECT_DEBUG}-${theme}-${language}-${width}.json`, JSON.stringify(spans))
  await click(rec)
  await app.waitForFrame(frame => frame.includes(toggleOn))
  expect(app.captureCharFrame()).toContain(language === "ru" ? "Последняя запись" : "Last write")
  if (process.env.CAPTURE_PROJECT_DEBUG && theme === "vesper" && language === "ru") await Bun.write(`${process.env.CAPTURE_PROJECT_DEBUG}-path-${width}.json`, JSON.stringify(app.captureSpans()))
  await click(toggleOn)
  await app.waitForFrame(frame => frame.includes(toggleOff))
  expect(await ProjectDebug.enabled(directory)).toBe(false)
})
