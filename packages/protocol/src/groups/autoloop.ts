import { AutoloopCard } from "@orchestra/schema/autoloop-card"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
  AutoloopCardNotFoundError,
  ConflictError,
  InvalidRequestError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../errors.js"

const errors = [AutoloopCardNotFoundError, ConflictError, InvalidRequestError, ServiceUnavailableError, UnauthorizedError]

export const AutoloopGroup = HttpApiGroup.make("server.autoloop")
  .add(
    HttpApiEndpoint.get("autoloop.cards.list", "/api/autoloop/cards", {
      success: Schema.Array(AutoloopCard.Card),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "autoloop.cards.list",
        summary: "List open autoloop cards",
        description:
          "Open ask/notice cards from the native autoloop cycle, oldest first: the questions the cycle is waiting on a human for. Answered and closed cards are not listed; the journal keeps them.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("autoloop.cards.answer", "/api/autoloop/cards/:id/answer", {
      params: { id: Schema.NumberFromString },
      payload: AutoloopCard.Answer,
      success: AutoloopCard.AnswerResult,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "autoloop.cards.answer",
        summary: "Answer an autoloop card",
        description:
          "Answer an ask card by option index, free text, or both. The answer is a fact in the journal: it records card.answered (with the chosen option) and starts a new round when the card belongs to a rule, except answering “Отменить задачу”, which cancels the task and starts no round. Answering an already decided card changes nothing.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "autoloop",
      description:
        "Native autoloop cards: questions the cycle asks a human, and the answers. Card events also arrive on the event stream as autoloop.card.created / answered / updated.",
    }),
  )
