import { Plugin } from "@orchestra/core/plugin"
import { Recovery } from "@orchestra/core/recovery"
import { ServiceUnavailableError } from "@orchestra/protocol/errors"
import { Duration, Effect, Option, Semaphore } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { requireLocationDirectory, response } from "../location"

// One repair round at a time per server (T3-6): a round is up to 12 model calls plus shell
// time, so a second concurrent round would double the token burn for the same broken server.
// The permit is taken without waiting — a second caller is refused with 503, not queued
// behind a round that can run for 10 minutes.
const repairRound = Semaphore.makeUnsafe(1)

/**
 * Runs one repair round under the server-wide guard: at most one round at a time, and the
 * whole round — model calls and shell together — must finish within the timeout. The
 * timeout interrupts the round; a second caller gets a 503 instead of waiting. Exported
 * so tests can exercise the guard without a live model.
 */
export const runRepairRound = <A, R>(
  round: Effect.Effect<A, never, R>,
  timeout: Duration.DurationInput = "10 minutes",
): Effect.Effect<A, ServiceUnavailableError, R> =>
  Effect.gen(function* () {
    const result = yield* repairRound.withPermitsIfAvailable(1)(
      round.pipe(
        Effect.timeout(timeout),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new ServiceUnavailableError({
              message: `The repair round timed out after ${typeof timeout === "string" ? timeout : `${Duration.toMillis(Duration.decode(timeout))}ms`}; try again with a shorter description`,
              service: "recovery",
            }),
          ),
        ),
      ),
    )
    if (Option.isNone(result))
      return yield* new ServiceUnavailableError({
        message: "Another repair round is already running; try again when it finishes",
        service: "recovery",
      })
    return result.value
  })

export const RecoveryHandler = HttpApiBuilder.group(Api, "server.recovery", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "recovery.models",
        Effect.fn(function* () {
          // T3-11: a missing directory answers 404 like the other catalogs (G2-6/N3),
          // instead of a confident-looking global list for a location that is not there.
          yield* requireLocationDirectory()
          // Providers are registered by plugin activation, so a request that lands during
          // startup used to answer with an empty catalog.
          yield* Plugin.awaitActivation
          const recovery = yield* Recovery.Service
          return yield* response(recovery.listModels())
        }),
      )
      .handle(
        "recovery.chat",
        Effect.fn(function* (ctx) {
          yield* requireLocationDirectory()
          yield* Plugin.awaitActivation
          const recovery = yield* Recovery.Service
          return yield* runRepairRound(recovery.chat({ model: ctx.payload.model, messages: ctx.payload.messages }))
        }),
      )
  }),
)
