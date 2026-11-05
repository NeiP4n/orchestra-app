export * as AutoloopCard from "./autoloop-card.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"

// A native autoloop card (block Б3, подшаг 2): a question (ask) or a notice
// a human has to see. The journal (`packages/core/src/autoloop/`) is the
// source of truth; this is the public shape the API and the SSE stream show.
// `question` / `interact` stay as UI — the card in the journal is what a
// question is, and answering it is a fact in the journal, not a prompt reply.

export const Kind = Schema.Literals(["ask", "notice"]).annotate({ identifier: "AutoloopCard.Kind" })
export type Kind = typeof Kind.Type

export const State = Schema.Literals(["open", "closed", "decided", "done"]).annotate({
  identifier: "AutoloopCard.State",
})
export type State = typeof State.Type

/** A card as clients see it: what to ask, the options, and what happened to it. */
export const Card = Schema.Struct({
  id: Schema.Int,
  key: Schema.String,
  kind: Kind,
  title: Schema.String,
  text: Schema.String,
  options: Schema.Array(Schema.String),
  recommend: Schema.NullOr(Schema.String),
  about: Schema.String,
  state: State,
  choice: Schema.NullOr(Schema.Int),
  answer: Schema.NullOr(Schema.String),
  by: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.Int),
  createdAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  closedAt: Schema.NullOr(Schema.String),
}).annotate({ identifier: "AutoloopCard.Card" })
export interface Card extends Schema.Schema.Type<typeof Card> {}

/** What answering a card takes: an option index, a free-text answer, or both. */
export const Answer = Schema.Struct({
  choice: optional(Schema.Int),
  text: optional(Schema.String),
  by: optional(Schema.String),
}).annotate({ identifier: "AutoloopCard.Answer" })
export interface Answer extends Schema.Schema.Type<typeof Answer> {}

/** What answering a card gives back: the card, and the new run when the answer started one. */
export const AnswerResult = Schema.Struct({
  card: Card,
  changed: Schema.Boolean,
  newRunId: Schema.NullOr(Schema.Int),
}).annotate({ identifier: "AutoloopCard.AnswerResult" })
export interface AnswerResult extends Schema.Schema.Type<typeof AnswerResult> {}

const cardData = { card: Card }

/** A card appeared: a human is being asked something, or told something. */
const Created = ephemeral({ type: "autoloop.card.created", schema: cardData })

/** A card was answered: the answer is a fact now, and a new round may have started. */
const Answered = ephemeral({ type: "autoloop.card.answered", schema: cardData })

/** A card changed some other way: closed, resolved, or given up on. */
const Updated = ephemeral({ type: "autoloop.card.updated", schema: cardData })

export const Event = { Created, Answered, Updated, Definitions: inventory(Created, Answered, Updated) }
