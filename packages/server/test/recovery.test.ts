import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
// The fixture boots the server process first: importing the recovery handler as the
// entry point trips a pre-existing circular-import TDZ in core tool/mcp.ts
// (Tool.node read before tool.ts initializes — the base handler crashes the same way).
// The real server never hits it because its entry primes the graph first.
import { startServer } from "./fixture/server"
import { runRepairRound } from "../src/handlers/recovery"

// T3-6: one repair round at a time, with a total timeout — a round is up to 12 model calls
// plus shell time, so an unbounded concurrent round is an unbounded token burn.
it.live("a second concurrent repair round is refused and the permit frees afterwards", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const first = yield* runRepairRound(
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Effect.never
      }),
      "10 seconds",
    ).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const refused = yield* runRepairRound(Effect.succeed("second")).pipe(Effect.exit)
    expect(Exit.isFailure(refused)).toBe(true)
    if (Exit.isFailure(refused)) expect(Cause.pretty(refused.cause)).toContain("already running")
    yield* Fiber.interrupt(first)
    expect(yield* runRepairRound(Effect.succeed("third"))).toBe("third")
  }).pipe(Effect.scoped),
)

it.live("a repair round that never finishes times out", () =>
  Effect.gen(function* () {
    const exit = yield* runRepairRound(Effect.never, "10 millis").pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("timed out")
  }),
)

// T3-11: recovery answers 404 for a missing directory like the other catalogs (G2-6/N3).
it.live("recovery.models answers 404 for a missing directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-recovery-")))
    const server = yield* startServer(tmp.path)
    const url = new URL("/api/recovery/models", server.base)
    url.searchParams.set("location[directory]", "/does/not/exist")
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    expect(response.status).toBe(404)
  }),
)
