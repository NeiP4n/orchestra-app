import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { ProjectDebug } from "@orchestra/core/session/project-debug"

for (const width of [48, 80]) test(`project recording toggle is opt-in and visible at ${width}`, async () => {
  await using state = await tmpdir()
  const directory = state.path
  const session = { id: "ses_debug", title: "Debug test", projectID: "project", location: { directory }, agent: "build", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 } }
  await using app = await createAppFixture({ width, height: 36, state: directory, args: { sessionID: session.id }, config: { animations: false, session: { sidebar: "hide" }, debug: { devtools: true } }, fetch: (url) => {
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
  await app.waitForFrame(frame => frame.includes("Server"))
  const click = async (text: string) => {
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findIndex(line => line.includes(text))
    if (y < 0) throw Error("missing action: " + text + "\n" + lines.join("\n"))
    await app.mockMouse.click(lines[y].indexOf(text) + 1, y)
  }
  await click("Debug OFF")
  await app.waitForFrame(frame => frame.includes("Project recording: OFF"))
  expect(await ProjectDebug.enabled(directory)).toBe(false)
  await click("Project recording: OFF")
  await app.waitForFrame(frame => frame.includes("REC debug"))
  expect(await ProjectDebug.enabled(directory)).toBe(true)
  if (process.env.CAPTURE_PROJECT_DEBUG) await Bun.write(`${process.env.CAPTURE_PROJECT_DEBUG}-${width}.json`, JSON.stringify(app.captureSpans()))
  await click("Project recording: ON")
  await app.waitForFrame(frame => frame.includes("Project recording: OFF"))
  expect(await ProjectDebug.enabled(directory)).toBe(false)
})
