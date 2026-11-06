export * as PromptIntakePolicy from "./policy.js"

import { keywords } from "./normalize.js"
import type { Disposition, ValueAssessment } from "./types.js"

/**
 * A prompt this short cannot be proven to be the same work: its keywords may
 * all sit inside a longer board item by accident (a subset match, m-10), so
 * a skip/merge verdict on it stays advisory text in the enriched prompt and
 * never blocks admission. Refusal needs enough words to be sure.
 */
export const MIN_KEYWORDS_FOR_REFUSAL = 3

/**
 * Turns the value verdict into an admission decision. This is the policy as
 * code: a refusal verdict is not a hint the agent may ignore, it is a
 * decision `SessionPrompt.prepare` enforces — nothing is admitted, no drain
 * starts, no tokens are spent, and the reason goes back to the sender.
 *
 * - `execute` admits: the work is new and clear.
 * - `clarify` refuses: the prompt cannot be acted on until the user answers,
 *   and the questions ride in the refusal reason so the sender knows what is
 *   missing. Admitting it would spend a drain on guessing.
 * - `skip`/`merge` refuse, but only for a prompt with enough keywords to be
 *   sure it is the same work (see `MIN_KEYWORDS_FOR_REFUSAL`); a short
 *   prompt is admitted with the verdict as advisory text instead.
 */
export function dispositionFor(assessment: ValueAssessment, text: string): Disposition {
  if (assessment.verdict === "execute") return { action: "admit" }
  if (assessment.verdict === "clarify") {
    const questions =
      assessment.questions.length > 0 ? ` Уточни: ${assessment.questions.join(" ")}` : ""
    return { action: "refuse", reason: `${assessment.reasons.join(" ")}${questions}` }
  }
  if (keywords(text).length < MIN_KEYWORDS_FOR_REFUSAL) return { action: "admit" }
  return { action: "refuse", reason: assessment.reasons.join(" ") }
}
