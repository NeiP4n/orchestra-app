export * as TriggerReview from "./trigger-review.js"
import { createHash } from "node:crypto"
import type { Trigger } from "./trigger.js"

/** A review covers configuration, not counters or the scheduler's next tick. */
export function snapshot(trigger: Trigger.Info) {
  const configuration = {
    id: trigger.id,
    projectID: trigger.projectID,
    kind: trigger.kind,
    spec: trigger.spec,
    prompt: trigger.prompt,
    match: trigger.match,
    browserSessionID: trigger.browserSessionID,
    condition: trigger.condition,
    actions: trigger.actions,
    localTest: trigger.localTest,
    missedPolicy: trigger.missedPolicy,
    maxPerHour: trigger.maxPerHour,
    maxPerDay: trigger.maxPerDay,
    publishApproved: trigger.publishApproved,
  }
  const digest = createHash("sha256").update(JSON.stringify(configuration)).digest("hex")
  return {
    digest,
    prompt: trigger.prompt,
    source: `${trigger.kind}: ${trigger.spec}${trigger.match ? `; ${trigger.match}` : ""}`,
    browser: trigger.kind === "browser" || !!trigger.browserSessionID,
    condition: trigger.condition ? JSON.stringify(trigger.condition) : "",
    actions: trigger.actions ? JSON.stringify(trigger.actions) : "",
  }
}

export function matches(trigger: Trigger.Info, digest: string) {
  return !trigger.enabled && snapshot(trigger).digest === digest
}
