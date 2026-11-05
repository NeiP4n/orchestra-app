import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
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
