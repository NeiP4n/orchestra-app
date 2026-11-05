export * as SessionEscalate from "./escalate.js"

import { Effect } from "effect"
import { Bus } from "../../bus.js"
import { SessionEvent } from "../event.js"
import { SessionSchema } from "../schema.js"
import { classifyError, type TaxonomyEntry } from "./error-taxonomy.js"

/**
 * Escalation ladder as code (block Б5).
 *
 * Any error first goes to the session's own orchestrator (it already sees
 * every failure as a durable step failure). When the orchestrator cannot
 * clear it — retries and model fallbacks exhausted — the failure climbs:
 * the society (`consultGroup`/`consult_all`) when the project belongs to a
 * council group, otherwise the president (`reportToPresident`). Nothing is
 * ever "told to the operator to wait": waiting for a human is not a step on
 * this ladder, and a silent log line is not an escalation.
 */
export type EscalationTarget = "orchestrator" | "society" | "president"

export interface Escalation {
  readonly entry: TaxonomyEntry
  readonly target: EscalationTarget
  readonly reason: string
}

export function ladder(input: {
  readonly cause: unknown
  /** True when retries and model fallbacks are exhausted for this failure. */
  readonly limitsExhausted: boolean
  /** True when the project belongs to a council-mode group that can be consulted. */
  readonly hasSociety?: boolean
  /** True when a lead-mode group president exists for this project. */
  readonly hasPresident?: boolean
}): Escalation {
  const entry = classifyError(input.cause)
  if (!input.limitsExhausted)
    return { entry, target: "orchestrator", reason: `error ${entry.code} stays with the orchestrator while retries remain` }
  if (input.hasSociety === true)
    return {
      entry,
      target: "society",
      reason: `error ${entry.code} exhausted retries; the society is consulted`,
    }
  if (input.hasPresident === true)
    return {
      entry,
      target: "president",
      reason: `error ${entry.code} exhausted retries; reported to the president`,
    }
  return {
    entry,
    target: "orchestrator",
    reason: `error ${entry.code} exhausted retries; no society or president exists, so the orchestrator reports it as a durable failure`,
  }
}

/**
 * Make an exhausted failure visible in the session itself: a durable
 * synthetic message the orchestrator (and the operator, reading the chat)
 * cannot miss. A log line alone is not an escalation — this is the record
 * the next rung of the ladder (society / president) is built from.
 */
export const announce = (input: {
  readonly bus: Bus.Interface
  readonly sessionID: SessionSchema.ID
  readonly cause: unknown
  readonly escalation: Escalation
}) =>
  Effect.gen(function* () {
    const entry = input.escalation.entry
    yield* Effect.logWarning("error exhausted retries and fallbacks; escalating", {
      sessionID: input.sessionID,
      code: entry.code,
      action: entry.action,
      target: input.escalation.target,
    })
    yield* input.bus.publish(SessionEvent.Synthetic, {
      sessionID: input.sessionID,
      text:
        `Ошибка ${entry.code} (${entry.title}) исчерпала повторы и смену модели. ` +
        `Эскалация: ${input.escalation.target}. ${input.escalation.reason}`,
      description: "Error escalation",
      metadata: { code: entry.code, action: entry.action, target: input.escalation.target },
    })
  })
