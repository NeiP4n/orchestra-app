import { expect } from "bun:test"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Schedule } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("backend debug toggle mid-Orchestrator chat writes to its returned path and OFF stops", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("debug-server-")))
    const handler = yield* ServerFetch.make({ app: { version: "test" }, database: { path: ":memory:" }, fs: { filewatcher: false }, models: { fetch: false }, config: { directory: tmp.path, project: false, content: "{}" } }, { allowUnauthenticated: true })
    const call = (route: string, method = "GET", body?: unknown) => Effect.promise(async () => {
      const response = await handler(new Request(`http://opencode.local${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }))
      return { status: response.status, body: await response.json() as any }
    })
    const created = yield* call("/api/orchestra/project", "POST", { name: "Debug", directory: tmp.path })
    expect(created.status).toBe(200)
    const project = created.body
    const endpoint = `/api/orchestra/project/${project.id}/debug`
    expect((yield* call(endpoint)).body).toMatchObject({ enabled: false, bytes: 0 })
    yield* call(`/api/session/${project.main}/prompt`, "POST", { text: "before toggle", resume: false })
    yield* Effect.sleep("30 millis")
    const started = yield* call(endpoint, "PUT", { enabled: true })
    expect(started.status).toBe(200)
    expect(started.body.path).toBe(path.join(tmp.path, ".orchestra/project-debug.jsonl"))
    expect(started.body.bytes).toBeGreaterThan(0)
    expect(started.body.lastWrite).toBeNumber()
    const prompt = yield* call(`/api/session/${project.main}/prompt`, "POST", { text: "after toggle", resume: false })
    expect(prompt.status).toBe(200)
    const text = yield* Effect.tryPromise(() => readFile(started.body.path, "utf8")).pipe(Effect.filterOrFail(text => text.includes("after toggle")), Effect.retry(Schedule.spaced("20 millis")), Effect.timeout("3 seconds"))
    expect(text).toContain("after toggle")
    expect(text).not.toContain("before toggle")
    expect(text).toContain(project.main)
    expect((yield* call(endpoint)).body.bytes).toBeGreaterThan(started.body.bytes)
    yield* call(endpoint, "PUT", { enabled: false })
    yield* call(`/api/session/${project.main}/prompt`, "POST", { text: "after OFF", resume: false })
    yield* Effect.sleep("30 millis")
    expect(yield* Effect.promise(() => readFile(started.body.path, "utf8"))).not.toContain("after OFF")
    expect((yield* call("/api/orchestra/project/prj_missing/debug")).status).toBe(400)
    expect(yield* Effect.promise(() => readdir(tmp.path))).not.toContain("debug-recording.json")
  }).pipe(Effect.scoped),
)
