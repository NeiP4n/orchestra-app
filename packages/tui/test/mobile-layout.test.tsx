import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

// A phone in Termux is about 48 columns wide. The mobile layout folds the side panels to edge
// rails there and opens them over the screen, where the normal layout drops them altogether.
const WIDTH = 48
const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = (id: string, title: string) => ({
  id,
  title,
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
})
const worker = session("ses_worker", "Worker task")
const main = session("ses_main", "Lead")

function render(state: string, layout?: "mobile", input: { width?: number; devtools?: boolean } = {}) {
  return createAppFixture({
    width: input.width ?? WIDTH,
    height: 36,
    state,
    args: { sessionID: worker.id },
    config: { animations: false, layout, ...(input.devtools ? { debug: { devtools: true } } : {}) },
    fetch: (url) => {
      const path = url.pathname
      if (path === "/api/location") return json(location)
      if (path === "/api/orchestra/project") return json([{ id: "prj_demo", name: "Demo", directory, created: 0 }])
      if (path === "/api/orchestra/project/prj_demo/session") return json({ data: [worker], access: {} })
      if (path === "/api/orchestra/project/prj_demo/main") return json(main)
      if (path === "/api/session") return json({ data: [worker], cursor: {} })
      const known = [worker, main].find((item) => path === `/api/session/${item.id}`)
      if (known) return json({ data: known })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(path)) return json({ data: [], cursor: {} })
      if (path === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (path === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
      if (path === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
    },
  })
}

async function click(setup: Awaited<ReturnType<typeof render>>, needle: string, last = false) {
  await setup.renderOnce()
  const lines = setup.captureCharFrame().split("\n")
  const y = last ? lines.findLastIndex((line) => line.includes(needle)) : lines.findIndex((line) => line.includes(needle))
  if (y < 0) throw new Error(`no "${needle}" on screen:\n${lines.join("\n")}`)
  await setup.mockMouse.click(last ? lines[y]!.lastIndexOf(needle) : lines[y]!.indexOf(needle), y)
}

test("at phone width the normal layout drops the project panel", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path)
  await setup.ready
  const frame = await setup.waitForFrame((frame) => frame.includes("Build"))
  expect(frame.split("\n").some((line) => line.startsWith(" ›"))).toBe(false)
})

test("the mobile project panel opens over the chat and closes when a session is picked", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, "mobile")
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Build") && frame.split("\n").some((line) => line.startsWith(" ›")))

  await click(setup, "›")
  const open = await setup.waitForFrame((frame) => frame.includes("★ Orchestrator"))
  // The panel takes the whole width instead of squeezing the chat beside it.
  expect(open.split("\n").find((line) => line.includes("Projects"))?.trimEnd().endsWith("‹")).toBe(true)
  expect(open).not.toContain("Build")

  await click(setup, "★ Orchestrator")
  const closed = await setup.waitForFrame((frame) => !frame.includes("★ Orchestrator"))
  expect(closed.split("\n").some((line) => line.startsWith(" ›"))).toBe(true)
})

test("the mobile session sidebar opens across the screen", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, "mobile")
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Build") && frame.includes("‹"))

  await click(setup, "‹", true)
  const frame = await setup.waitForFrame((frame) => frame.includes(worker.title))
  const title = frame.split("\n").find((line) => line.includes(worker.title))!
  // A sidebar clamped beside a 56-column chat would be a single column at the right edge.
  expect(title.indexOf(worker.title)).toBeLessThan(10)
})

test.each([48, 64])("at %i columns the mini skills and the bottom bar stay on screen", async (width) => {
  await using state = await tmpdir()
  await using setup = await render(state.path, "mobile", { width, devtools: true })
  await setup.ready
  // Both rows used to run past the right edge: "⚙ Sk" and "Te" were all a phone showed of them.
  const frame = await setup.waitForFrame((frame) => frame.includes("⚙ Skills") && frame.includes("Language"))
  const lines = frame.split("\n")
  expect(lines.find((line) => line.includes("⚙ Skills"))).toContain("│")
  expect(lines.find((line) => line.includes("Server"))?.trimEnd().endsWith("Language EN")).toBe(true)
})
