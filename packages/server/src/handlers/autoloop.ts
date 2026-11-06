import { AutoloopCards } from "@orchestra/core/autoloop/cards"
import { Bus } from "@orchestra/core/bus"
import {
  AutoloopCardNotFoundError,
  ConflictError,
  InvalidRequestError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "@orchestra/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

const cardError = (id: number, error: AutoloopCards.CardsFailure) => {
  if (error.code === "not-found") return new AutoloopCardNotFoundError({ id, message: error.message })
  if (error.code === "forbidden") return new UnauthorizedError({ message: error.message })
  if (error.code === "conflict") return new ConflictError({ message: error.message })
  if (error.code === "unavailable") {
    return new ServiceUnavailableError({ message: error.message, service: "autoloop" })
  }
  return new InvalidRequestError({ message: error.message })
}

export const AutoloopHandler = HttpApiBuilder.group(Api, "server.autoloop", (handlers) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    return handlers
      .handle("autoloop.cards.list", () =>
        AutoloopCards.listOpenCards().pipe(Effect.mapError((error) => cardError(-1, error))),
      )
      .handle(
        "autoloop.cards.answer",
        Effect.fn(function* (ctx) {
          const answered = yield* AutoloopCards.answerCard(ctx.params.id, ctx.payload).pipe(
            Effect.catchTag("Autoloop.CardsFailure", (error) => Effect.fail(cardError(ctx.params.id, error))),
            Effect.tap((result) => AutoloopCards.publish(bus, result.events)),
          )
          return { card: answered.card, changed: answered.changed, newRunId: answered.newRunId }
        }),
      )
      .handle(
        "autoloop.disputes.raise",
        Effect.fn(function* (ctx) {
          return yield* AutoloopCards.raiseDispute(ctx.payload).pipe(
            Effect.catchTag("Autoloop.CardsFailure", (error) => Effect.fail(cardError(-1, error))),
          )
        }),
      )
      .handle(
        "autoloop.disputes.resolve",
        Effect.fn(function* (ctx) {
          return yield* AutoloopCards.resolveDispute(ctx.params.id, ctx.payload.decision).pipe(
            Effect.catchTag("Autoloop.CardsFailure", (error) => Effect.fail(cardError(ctx.params.id, error))),
          )
        }),
      )
      .handle(
        "autoloop.disputes.escalate",
        Effect.fn(function* (ctx) {
          return yield* AutoloopCards.escalateDispute(ctx.params.id).pipe(
            Effect.catchTag("Autoloop.CardsFailure", (error) => Effect.fail(cardError(ctx.params.id, error))),
          )
        }),
      )
  }),
)
