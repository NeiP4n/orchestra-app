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
  .add(
    HttpApiEndpoint.post("autoloop.disputes.raise", "/api/autoloop/disputes", {
      payload: AutoloopCard.RaiseDispute,
      success: AutoloopCard.RaiseDisputeResult,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "autoloop.disputes.raise",
        summary: "Raise a dispute",
        description:
          "Raise a dispute between two positions on the timed ladder: it opens at the given level (or agent), climbs one rung when its deadline passes, and reaches the operator as a note. Nothing blocks while a dispute is open.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("autoloop.disputes.resolve", "/api/autoloop/disputes/:id/resolve", {
      params: { id: Schema.NumberFromString },
      payload: AutoloopCard.ResolveDispute,
      success: AutoloopCard.ResolveDisputeResult,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "autoloop.disputes.resolve",
        summary: "Resolve a dispute",
        description:
          "Resolve an open dispute with a decision: it stops climbing the ladder. Resolving an already resolved dispute changes nothing.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("autoloop.disputes.escalate", "/api/autoloop/disputes/:id/escalate", {
      params: { id: Schema.NumberFromString },
      success: AutoloopCard.EscalateDisputeResult,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "autoloop.disputes.escalate",
        summary: "Escalate a dispute",
        description:
          "Move an open dispute up one rung now, without waiting for its deadline. Reaching the operator records it as a note for the operator.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "autoloop",
      description:
        "Native autoloop cards: questions the cycle asks a human, and the answers. Card events also arrive on the event stream as autoloop.card.created / answered / updated. Disputes climb a timed ladder (agent → group-leader → council → orchestrator → operator) and never block work.",
    }),
  )
