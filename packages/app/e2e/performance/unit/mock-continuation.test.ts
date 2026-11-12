import { expect, test } from "bun:test"
import { createMockServerHandler } from "../../utils/mock-server"

test("continuation API mock defaults ON, persists OFF and emits state update", async () => {
  const events: unknown[] = []

  const server = createMockServerHandler(
    { provider: {}, directory: "/project", project: {}, sessions: [], pageMessages: () => ({ items: [] }) },
    (batch) => events.push(...batch),
  )

  try {
    const url = "http://localhost/api/config/continuation"
    const first = await server.handler(new Request(url))
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ enabled: true })

    const changed = await server.handler(
      new Request(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    )

    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ enabled: false })
    expect(await (await server.handler(new Request(url))).json()).toEqual({ enabled: false })
    expect(events).toEqual([{ type: "config.continuation.updated", data: { enabled: false } }])
  } finally {
    await server.dispose()
  }
})
