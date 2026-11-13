import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

for (const language of ["en", "ru"] as const) for (const width of [32, 48, 80, 120]) for (const view of ["home", "session"] as const) {
  test(`global pause is visible and reachable on ${view} at ${width} columns (${language})`, async () => {
    const on = language === "en" ? "All projects: ON" : "Все проекты: ВКЛ"
    const paused = language === "en" ? "All projects: PAUSED" : "Все проекты: ПАУЗА"
    const resume = language === "en" ? "Resume all projects" : "Продолжить все проекты"
    let enabled = true
    const writes: boolean[] = []
    let publish = (_enabled: boolean) => {}
    const session = { id: "ses_pause_matrix", title: "Pause matrix", projectID: "project", location: { directory }, agent: "build", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 } }
    await using app = await createAppFixture({
      width, height: 30,
      args: view === "session" ? { sessionID: session.id } : {},
      config: { language, animations: false, debug: { devtools: false } },
      fetch: async (url, request) => {
        if (url.pathname === "/api/config/continuation") {
          if (request.method === "PUT") { enabled = (await request.json()).enabled; writes.push(enabled); publish(enabled) }
          return json({ enabled })
        }
        if (url.pathname === "/api/location") return json({ directory, project: { id: "project", directory, canonical: directory } })
        if (url.pathname === "/api/session") return json({ data: [session] })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
      },
    })
    publish = enabled => app.events.emit({ id: "evt_pause_matrix", type: "config.continuation.updated", data: { enabled } })
    await app.ready
    await app.waitForFrame(frame => frame.includes(on))
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findIndex(line => line.includes(on))
    await app.mockMouse.click(lines[y].indexOf(on) + 1, y)
    await app.waitForFrame(frame => frame.includes(paused))
    expect(enabled).toBe(false)
    expect(writes).toEqual([false])
    if (process.env.CAPTURE_CONTINUATION_APP) await Bun.write(`${process.env.CAPTURE_CONTINUATION_APP}-${language}-${view}-${width}.json`, JSON.stringify(app.captureSpans()))
    await app.mockInput.pressKey("p", { ctrl: true })
    await app.waitForFrame(frame => frame.includes(language === "en" ? "Search" : "Поиск"))
    await app.waitFor(() => app.renderer.currentFocusedRenderable?.constructor.name === "InputRenderable")
    await app.mockInput.typeText("Resume all projects")
    await app.waitForFrame(frame => frame.includes(width === 32 ? resume.slice(0, 16) : resume))
    expect(app.captureCharFrame()).not.toContain(language === "en" ? "No results" : "Ничего не найдено")
    if (process.env.CAPTURE_CONTINUATION_APP) await Bun.write(`${process.env.CAPTURE_CONTINUATION_APP}-palette-${language}-${view}-${width}.json`, JSON.stringify(app.captureSpans()))
    await app.mockInput.pressEnter()
    await app.waitForFrame(frame => frame.includes(on) && !frame.includes(width === 32 ? resume.slice(0, 16) : resume))
    expect(writes).toEqual([false, true])
  })
}

for (const language of ["en", "ru"] as const) test(`saved OFF stays visible without writes on boot at 32 (${language})`, async () => {
  let writes = 0
  await using app = await createAppFixture({ width: 32, height: 30, config: { language, animations: false, debug: { devtools: false } }, fetch: (url, request) => {
    if (url.pathname === "/api/config/continuation") { if (request.method !== "GET") writes++; return json({ enabled: false }) }
  } })
  await app.ready
  await app.waitForFrame(frame => frame.includes(language === "en" ? "All projects: PAUSED" : "Все проекты: ПАУЗА"))
  expect(writes).toBe(0)
})
