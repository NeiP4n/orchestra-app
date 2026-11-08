import { expect } from "bun:test"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import { HttpServer } from "effect/unstable/http"
import { AutoloopCard } from "@orchestra/schema/autoloop-card"
import { ConfigOrchestra } from "@orchestra/schema/config/orchestra"
import { Document, Info } from "@orchestra/schema/config"
import { Autoloop } from "@orchestra/core/autoloop/service"
import { createRun, finishRun } from "@orchestra/core/autoloop/orchestrator"
import { Config } from "@orchestra/core/config"
import { Bus } from "@orchestra/core/bus"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"
import { startServer } from "./fixture/server"

it.live("lists open autoloop cards, empty before any card exists", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-autoloop-endpoint-")))
    const server = yield* startServer(tmp.path)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/autoloop/cards", server.base), { headers: server.headers }),
    )

    expect(response.status).toBe(200)
    expect(yield* Effect.promise(() => response.json())).toEqual([])
  }),
)

it.live("answering a card that does not exist is a 404", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-autoloop-endpoint-")))
    const server = yield* startServer(tmp.path)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/autoloop/cards/99/answer", server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ choice: 0 }),
      }),
    )

    expect(response.status).toBe(404)
  }),
)

it.live("the tick service starts with the server layer and delivers cards to the event feed", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-autoloop-service-")))
    const context = yield* Layer.build(
      createRoutes({
        password: "secret",
        database: { path: ":memory:" },
        models: { fetch: false },
        fs: { filewatcher: false },
        config: { directory: tmp.path, project: false },
      }).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const autoloop = Context.get(context, Autoloop.Service)
    const bus = Context.get(context, Bus.Service)
    const created = yield* bus
      .subscribe(AutoloopCard.Event.Created)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow

    yield* autoloop.start()
    yield* autoloop.execute({ type: "createCard", args: [{ key: "hello", title: "hi", text: "hello" }] })

    const events = yield* Fiber.join(created)
    expect(events).toHaveLength(1)
    expect(events[0]!.data.card).toMatchObject({ key: "hello", title: "hi", state: "open" })
    const view = yield* autoloop.getView()
    expect(Object.values(view["cards"] ?? {})).toHaveLength(1)
    expect((yield* autoloop.stats()).ticks).toBe(0)
  }),
)

it.live("the server cycle takes the dispatch rule and operator limits from the operator config", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-autoloop-config-")))
    const context = yield* Layer.build(
      createRoutes({
        password: "secret",
        database: { path: ":memory:" },
        models: { fetch: false },
        fs: { filewatcher: false },
        config: { directory: tmp.path, project: false },
      }).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const autoloop = Context.get(context, Autoloop.Service)
    // The operator config, as a dispatch would see it: one failed attempt
    // stops the run at once, and the dispatch rule routes the task.
    const config = Config.testLayer([
      new Document({
        type: "document",
        info: new Info({
          orchestra: new ConfigOrchestra.Info({
            autoloop: new ConfigOrchestra.Autoloop({ maxAttempts: 1 }),
            // The default autonomy is observe, which records the event and routes nothing; this
            // test is about a dispatch that runs, so the operator config asks for auto.
            society: new ConfigOrchestra.Society({ autonomy: "auto" }),
          }),
        }),
      }),
    ])
    const created = yield* createRun(autoloop, {
      sessionID: "worker-1",
      projectID: "project-1",
      text: "fix the bug",
      messageID: "msg-1",
    }).pipe(Effect.provide(config))
    expect(created).not.toBeNull()
    expect(
      yield* finishRun(autoloop, { ...created!, receipt: { outcome: "failed", error: "boom" } }),
    ).toMatchObject({ status: "finished" })
    const view = yield* autoloop.getView()
    expect(view["runs"]?.[String(created!.run)]).toMatchObject({ state: "cancelled", attempts: 1 })
    expect(
      Object.values(view["cards"] ?? {}).map((card) => (card as Record<string, unknown>)["key"]),
    ).toContain(`run:${created!.run}:stopped`)
  }),
)
