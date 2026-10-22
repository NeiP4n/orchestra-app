import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@orchestra/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

// A group chat can be deleted while the group still names it (clear all sessions, a failed
// create, a mode change). Opening that stored id used to dead-link and leave the operator on the
// home prompt, where the next message created an unrelated session in the current project.
test("a missing group chat is reopened in the group instead of falling back to a project session", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const stale = "ses_group_deleted"
  const live = "ses_group_games"
  const session = {
    id: live,
    title: "Общество",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const seen: string[] = []
  const events = createEventStream()
  const calls = createFetch(async (url, request) => {
    seen.push(`${request.method} ${url.pathname}`)
    if (url.pathname === "/api/orchestra/group" && request.method === "GET")
      return json([{ name: "Games", projects: ["prj_a", "prj_b"], mode: "council", supervisor: stale }])
    if (url.pathname === "/api/orchestra/group/Games/chat" && request.method === "POST")
      return json({ sessionID: live, title: "Общество", directory })
    if (url.pathname === `/api/session/${stale}`) return json({ message: "Session not found" }, { status: 404 })
    if (url.pathname === `/api/session/${stale}/message`) return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${stale}/inbox`) return json({ data: [] })
    if (url.pathname === `/api/session/${live}`) return json({ data: session })
    if (url.pathname === `/api/session/${live}/message`)
      return json({ data: [{ type: "user", id: "msg_group", text: "Group chat reopened", time: { created: 0 } }], cursor: {} })
    if (url.pathname === `/api/session/${live}/inbox`) return json({ data: [] })
    if (url.pathname === `/api/session/${live}/permission`) return json({ data: [] })
    if (url.pathname === `/api/session/${live}/form`) return json({ data: [] })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { mode: "off" } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      args: { sessionID: stale },
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("Group chat reopened"))
    // The group owned the chat, so the server reopened it; the client never fell back to the
    // home prompt and never created a session in the project.
    expect(seen).toContain("POST /api/orchestra/group/Games/chat")
    expect(seen).toContain(`GET /api/session/${live}`)
    expect(seen.filter((entry) => entry === "POST /api/session")).toEqual([])
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 15000)
