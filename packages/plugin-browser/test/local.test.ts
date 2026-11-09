import { expect, test } from "bun:test"
import { createServer } from "node:net"
import { once } from "node:events"
import type { Session } from "@orchestra/schema/session"
import { Browser } from "../src/rpc.js"
import { LocalBrowser } from "../src/local/index.js"

// A stub Chromium: /json/version over HTTP, then CDP frames over one WebSocket. It answers the
// commands the local backend sends and records tab closes, so tests need no real browser.

type Stub = {
  endpoint: string
  closedTargets: string[]
  navigations: string[]
  stop: () => void
}

function stubBrowser(): Stub {
  let sequence = 0
  const tabs = new Map<string, { url: string; title: string }>()
  const stub: Stub = {
    endpoint: "",
    closedTargets: [],
    navigations: [],
    stop: () => server.stop(true),
  }
  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url)
      if (url.pathname === "/json/version")
        return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/ws` })
      if (url.pathname === "/ws" && srv.upgrade(request)) return undefined
      return new Response("not found", { status: 404 })
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as {
          id: number
          method: string
          params: Record<string, string | number | boolean>
          sessionId?: string
        }
        const reply = (result: unknown) => {
          ws.send(JSON.stringify({ id: frame.id, result }))
        }
        switch (frame.method) {
          case "Target.createTarget": {
            const targetId = `target-${++sequence}`
            tabs.set(targetId, { url: String(frame.params.url ?? "about:blank"), title: "" })
            return reply({ targetId })
          }
          case "Target.attachToTarget":
            return reply({ sessionId: `session-${frame.params.targetId}` })
          case "Target.getTargetInfo": {
            const tab = tabs.get(String(frame.params.targetId))
            return reply({ targetInfo: { url: tab?.url ?? "about:blank", title: tab?.title ?? "" } })
          }
          case "Target.closeTarget": {
            const targetId = String(frame.params.targetId)
            stub.closedTargets.push(targetId)
            tabs.delete(targetId)
            return reply({ success: true })
          }
          case "Page.getFrameTree":
            return reply({ frameTree: { frame: { id: "frame-1", url: "about:blank" } } })
          case "Page.getNavigationHistory":
            return reply({ currentIndex: 0, entries: [{ id: 1, url: "about:blank" }] })
          case "Page.navigate": {
            const url = String(frame.params.url)
            stub.navigations.push(url)
            const targetId = frame.sessionId?.replace(/^session-/, "")
            const tab = targetId ? tabs.get(targetId) : undefined
            if (tab) tab.url = url
            // No loaderId: treated as a same-document navigation, so no load wait follows.
            return reply({ frameId: "frame-1" })
          }
          default:
            return reply({})
        }
      },
    },
  })
  stub.endpoint = `http://127.0.0.1:${server.port}`
  return stub
}

const sessionA = "ses_localtest_a" as Session.ID
const sessionB = "ses_localtest_b" as Session.ID
const config = (endpoint: string, extra: Partial<LocalBrowser.Options> = {}): LocalBrowser.Options => ({
  endpoint,
  profile: "/tmp/orchestra-local-test-profile",
  headless: true,
  launchWaitMs: 5_000,
  ...extra,
})

test("options: headless built-in launch by default, env overrides", () => {
  const base = LocalBrowser.options({ XDG_DATA_HOME: "/tmp/orchestra-local-test-data" })
  expect(base.endpoint).toBe("http://127.0.0.1:9222")
  expect(base.headless).toBe(true)
  expect(base.launchWaitMs).toBe(LocalBrowser.LAUNCH_WAIT_MS)
  const custom = LocalBrowser.options({
    XDG_DATA_HOME: "/tmp/orchestra-local-test-data",
    ORCHESTRA_BROWSER_CDP_URL: "http://127.0.0.1:9333",
    ORCHESTRA_BROWSER_HEADLESS: "0",
    ORCHESTRA_BROWSER_LAUNCH_WAIT_MS: "60000",
    ORCHESTRA_BROWSER_LAUNCHER: "start-chromium --remote-debugging-port=9333",
  })
  expect(custom.endpoint).toBe("http://127.0.0.1:9333")
  expect(custom.headless).toBe(false)
  expect(custom.launchWaitMs).toBe(60_000)
  expect(custom.launcher).toBe("start-chromium --remote-debugging-port=9333")
  // An unparseable wait falls back to the default instead of launching with no deadline.
  expect(
    LocalBrowser.options({ XDG_DATA_HOME: "/tmp/orchestra-local-test-data", ORCHESTRA_BROWSER_LAUNCH_WAIT_MS: "soon" })
      .launchWaitMs,
  ).toBe(LocalBrowser.LAUNCH_WAIT_MS)
})

test("launchArgs: headless flag, endpoint port, profile; headless opt-out", () => {
  const args = LocalBrowser.launchArgs(config("http://127.0.0.1:9444"))
  expect(args).toContain("--headless=new")
  expect(args).toContain("--remote-debugging-port=9444")
  expect(args).toContain("--remote-debugging-address=127.0.0.1")
  expect(args).toContain("--user-data-dir=/tmp/orchestra-local-test-profile")
  expect(args).toContain("--no-first-run")
  const headed = LocalBrowser.launchArgs(config("http://127.0.0.1:9444", { headless: false }))
  expect(headed).not.toContain("--headless=new")
  expect(headed).toContain("--remote-debugging-port=9444")
})

test("local manager drives tab lifecycle over a stub CDP browser", async () => {
  const stub = stubBrowser()
  try {
    const manager = LocalBrowser.make(config(stub.endpoint))
    const signal = new AbortController().signal

    const opened = await manager.execute(sessionA, { action: { type: "tabs.open" }, files: [] }, signal)
    const tab = opened.value as { id: string; url: string }
    expect(tab.id).toMatch(/^tab_/)
    expect(tab.url).toBe("about:blank")

    const listed = await manager.execute(sessionA, { action: { type: "tabs.list" }, files: [] }, signal)
    const state = listed.value as { tabs: { id: string }[]; focusedTabID: string | null }
    expect(state.tabs.map((t) => t.id)).toEqual([tab.id])
    expect(state.focusedTabID).toBe(tab.id)

    // Another session owns no tabs in the shared browser.
    const other = await manager.execute(sessionB, { action: { type: "tabs.list" }, files: [] }, signal)
    expect((other.value as { tabs: unknown[] }).tabs).toEqual([])

    const closed = await manager.execute(
      sessionA,
      { action: { type: "tabs.close", tabID: tab.id as Browser.TabID }, files: [] },
      signal,
    )
    expect((closed.value as { tabs: unknown[] }).tabs).toEqual([])
    expect(stub.closedTargets).toHaveLength(1)

    manager.dispose()
  } finally {
    stub.stop()
  }
}, 15_000)

test("tabs.open with a URL navigates and reports the loaded address", async () => {
  const stub = stubBrowser()
  try {
    const manager = LocalBrowser.make(config(stub.endpoint))
    const opened = await manager.execute(
      sessionA,
      { action: { type: "tabs.open", url: "https://example.test/" }, files: [] },
      new AbortController().signal,
    )
    expect(stub.navigations).toEqual(["https://example.test/"])
    expect((opened.value as { url: string }).url).toBe("https://example.test/")
    manager.dispose()
  } finally {
    stub.stop()
  }
}, 15_000)

test("release closes every tab the session owns", async () => {
  const stub = stubBrowser()
  try {
    const manager = LocalBrowser.make(config(stub.endpoint))
    const signal = new AbortController().signal
    await manager.execute(sessionA, { action: { type: "tabs.open" }, files: [] }, signal)
    await manager.execute(sessionA, { action: { type: "tabs.open" }, files: [] }, signal)
    await manager.execute(sessionB, { action: { type: "tabs.open" }, files: [] }, signal)

    await manager.release(sessionA)
    expect(stub.closedTargets).toHaveLength(2)
    const remaining = await manager.execute(sessionB, { action: { type: "tabs.list" }, files: [] }, signal)
    expect((remaining.value as { tabs: unknown[] }).tabs).toHaveLength(1)

    manager.dispose()
  } finally {
    stub.stop()
  }
}, 15_000)

test("a browser that never answers fails the call with the endpoint and wait named", async () => {
  // Reserve a port and close it, so nothing answers there.
  const probe = createServer()
  await once(probe.listen(0, "127.0.0.1"), "listening")
  const address = probe.address()
  if (!address || typeof address === "string") throw new Error("No TCP address")
  probe.close()
  await once(probe, "close")

  const manager = LocalBrowser.make(
    config(`http://127.0.0.1:${address.port}`, { launcher: "true", launchWaitMs: 1_200 }),
  )
  const failure = await manager
    .execute(sessionA, { action: { type: "tabs.open" }, files: [] }, new AbortController().signal)
    .then(
      () => "",
      (error: Error) => error.message,
    )
  expect(failure).toContain(`No Chromium answered at http://127.0.0.1:${address.port}`)
  expect(failure).toContain("within 1.2 s")
  manager.dispose()
}, 15_000)
