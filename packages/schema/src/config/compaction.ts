export * as ConfigCompaction from "./compaction.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

export class Keep extends Schema.Class<Keep>("Config.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(optional),
}) {}

// A share of the context window as a whole percent, bounded so a typo cannot compact every step.
const percent = Schema.Number.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100)),
)

export class Info extends Schema.Class<Info>("Config.Compaction")({
  auto: Schema.Boolean.pipe(optional),
  keep: Keep.pipe(optional),
  buffer: NonNegativeInt.pipe(optional),
  // Most tokens a request may carry before automatic compaction, whatever the model's window; 0 uses the window.
  threshold: NonNegativeInt.pipe(optional),
  // Share (0-100) of the model's context window in use before automatic compaction runs.
  threshold_percent: percent.pipe(optional),
  // Share (0-100) of the window left free after a compact, for the reply and a safety margin.
  keep_free_percent: percent.pipe(optional),
}) {}
