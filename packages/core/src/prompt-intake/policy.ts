export * as PromptIntakePolicy from "./policy.js"

import type { Disposition, ValueAssessment } from "./types.js"

/**
 * Turns the value verdict into an admission decision. This is the policy as
 * code, and the policy is: the intake never refuses a prompt. Every verdict
 * admits — the prompt always reaches the model, and the verdict rides along
 * as advisory text in the short internal intake note (see
 * `session/runner/to-llm-message.ts`), where the model either works out
 * the task itself or asks the user a clarifying question in chat.
 *
 * - `execute` admits: the work is new and clear.
 * - `clarify` admits with the questions in the advisory reason: the prompt
 *   cannot be acted on as-is, but guessing in a drain is better than
 *   refusing — the model asks what is missing instead of the sender
 *   getting a "Prompt rejected" box and the prompt never being sent.
 * - `skip`/`merge` admit with the reason: the work looks already done or
 *   duplicated, but the check is heuristic and can be wrong, so the model
 *   verifies it and tells the user instead of the prompt being dropped
 *   unseen. A prompt is never silently discarded.
 */
export function dispositionFor(assessment: ValueAssessment): Disposition {
  if (assessment.verdict === "execute") return { action: "admit" }
  if (assessment.verdict === "clarify") {
    const questions =
      assessment.questions.length > 0 ? ` Уточни: ${assessment.questions.join(" ")}` : ""
    return { action: "admit", reason: `${assessment.reasons.join(" ")}${questions}` }
  }
  return { action: "admit", reason: assessment.reasons.join(" ") }
}
