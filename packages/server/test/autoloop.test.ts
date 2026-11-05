import { expect } from "bun:test"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import { HttpServer } from "effect/unstable/http"
import { AutoloopCard } from "@orchestra/schema/autoloop-card"
import { Autoloop } from "@orchestra/core/autoloop/service"
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
