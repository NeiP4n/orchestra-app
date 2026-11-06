export * as Recovery from "./recovery.js"

import { Schema } from "effect"
import { Model } from "./model.js"
import { Provider } from "./provider.js"
import { optional } from "./schema.js"

/**
 * A model the recovery mini-chat offers. Only models on providers that are
 * actually working right now are listed — dead providers are never offered.
 */
export interface RecoveryModel extends Schema.Schema.Type<typeof RecoveryModel> {}
export const RecoveryModel = Schema.Struct({
  providerID: Provider.ID,
  id: Model.ID,
  name: Schema.String,
})

/** One message of the recovery chat transcript. Content is capped at 8000 characters (T3-6):
 * an unbounded transcript is an unbounded model context, paid for by the operator. */
export interface RecoveryChatMessage extends Schema.Schema.Type<typeof RecoveryChatMessage> {}
export const RecoveryChatMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String.check(Schema.isMaxLength(8000)),
})

/** The whole transcript of one repair round: at most 20 messages (T3-6). */
export type RecoveryChatTranscript = Schema.Schema.Type<typeof RecoveryChatTranscript>
export const RecoveryChatTranscript = Schema.Array(RecoveryChatMessage).check(Schema.isMaxLength(20))

/** One tool call the repair agent made, with its (truncated) result. */
export interface RecoveryStep extends Schema.Schema.Type<typeof RecoveryStep> {}
export const RecoveryStep = Schema.Struct({
  tool: Schema.String,
  input: Schema.Unknown,
  output: Schema.String,
  success: Schema.Boolean,
})

/** What one recovery chat round produced. */
export interface RecoveryResult extends Schema.Schema.Type<typeof RecoveryResult> {}
export const RecoveryResult = Schema.Struct({
  reply: Schema.String,
  steps: Schema.Array(RecoveryStep),
  /** What was fixed, when the agent said so (its `Исправлено:` line). */
  fixed: Schema.String.pipe(optional),
  inputTokens: Schema.Number.pipe(optional),
  outputTokens: Schema.Number.pipe(optional),
  model: Model.Ref,
})
