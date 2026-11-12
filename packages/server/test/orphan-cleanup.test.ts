import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("orphan API requires local host and a one-use backend preview", () => Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orphan-server-")))
  const handler = yield* ServerFetch.make({ app: { version: "test" }, database: { path: ":memory:" }, fs: { filewatcher: false }, models: { fetch: false }, config: { directory: tmp.path, project: false, content: "{}" } }, { allowUnauthenticated: true })
  const call = (route: string, body: unknown, host = "localhost") => Effect.promise(async () => {
    const response = await handler(new Request(`http://${host}${route}`, { method: "POST", headers: { "content-type": "application/json", host }, body: JSON.stringify(body) }))
    return { status: response.status, body: await response.json() as any }
  })
  expect((yield* call("/api/session-orphans/prepare", {}, "remote.invalid")).status).toBe(400)
  const prepared = yield* call("/api/session-orphans/prepare", {})
  expect(prepared.status).toBe(200)
  expect(prepared.body.count).toBe(0)
  const confirmed = yield* call("/api/session-orphans/confirm", { token: prepared.body.token })
  expect(confirmed.status).toBe(200)
  expect(confirmed.body).toMatchObject({ removed: 0, skipped: 0, deleted: [] })
  expect((yield* call("/api/session-orphans/confirm", { token: prepared.body.token })).status).toBe(400)
  expect((yield* call("/api/session-orphans/confirm", { token: "invented" })).status).toBe(400)
}).pipe(Effect.scoped))
