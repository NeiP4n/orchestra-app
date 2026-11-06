export * as ReviewAcceptance from "./acceptance.js"

// User-eyes acceptance run (idea #17): before delivery, the orchestrator
// itself walks the main scenario as a user would — in the real product,
// end to end — not only by tests. Tests check the code; the user sees what
// tests never notice.
//
// This module is the MECHANISM: the recorded run (the scenario, its steps,
// each step's pass/fail with evidence) and the delivery gate. The run itself
// is done at runtime by an agent driving the real product — this module
// never simulates it and never fakes a pass.
//
// Rules:
// - the run records the scenario's steps in order; each step is pass or fail
//   with evidence (what the agent saw, a screenshot reference, a command
//   output). A step with no result is pending, never an assumed pass;
// - the run passes only when every step passed; one failed step fails the
//   whole run;
// - delivery is blocked until the run passed — OR the run was explicitly
//   deferred WITH a reason (e.g. "the scenario needs a device the sandbox
//   has no access to"). A deferral without a reason is refused, and a
//   deferred run still shows in the record as deferred, never as passed.

export const StepResult = ["pass", "fail", "pending"] as const
export type StepResult = (typeof StepResult)[number]

export const RunStatus = ["pending", "passed", "failed", "deferred"] as const
export type RunStatus = (typeof RunStatus)[number]

export interface AcceptanceStep {
  readonly name: string
  /** What the user expects to see at this step. */
  readonly expected: string
  readonly result: StepResult
  /** What the agent actually saw: output, screenshot reference, error text. */
  readonly evidence?: string
  /** Why the step failed, when it did. */
  readonly reason?: string
}

export interface AcceptanceRun {
  readonly id: string
  /** The main scenario, as a user would describe it ("open the app, create a project, invite a member"). */
  readonly scenario: string
  readonly steps: readonly AcceptanceStep[]
  readonly status: RunStatus
  /** Why the run was deferred instead of passed. Required when status is "deferred". */
  readonly deferredReason?: string
  readonly createdAt: number
  readonly finishedAt?: number
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (message: string): Result<never> => ({ ok: false, message })

let counter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

/** Opens an acceptance run for one user scenario, with its steps in order. */
export function startRun(input: {
  readonly id?: string
  readonly scenario: string
  readonly steps: readonly { readonly name: string; readonly expected: string }[]
}): Result<AcceptanceRun> {
  if (!input.scenario.trim()) return fail("An acceptance run needs the user scenario it walks.")
  const steps = input.steps.map((step) => ({ name: step.name.trim(), expected: step.expected.trim() })).filter((step) => step.name !== "")
  if (steps.length === 0) return fail("An acceptance run needs at least one scenario step.")
  if (steps.some((step) => step.expected === "")) return fail("Every acceptance step needs what the user expects to see.")
  return ok({
    id: input.id?.trim() || nextId("acceptance"),
    scenario: input.scenario.trim(),
    steps: steps.map((step) => ({ ...step, result: "pending" as const })),
    status: "pending",
    createdAt: Date.now(),
  })
}

/** Records one step's outcome, with the evidence of what the agent actually saw. */
export function recordStep(
  run: AcceptanceRun,
  stepName: string,
  result: Exclude<StepResult, "pending">,
  input?: { readonly evidence?: string; readonly reason?: string },
): Result<AcceptanceRun> {
  if (run.status === "deferred") return fail(`Acceptance run ${run.id} was deferred; record a fresh run instead of editing a deferred one.`)
  const index = run.steps.findIndex((step) => step.name === stepName)
  if (index < 0) return fail(`Acceptance run ${run.id} has no step ${JSON.stringify(stepName)}.`)
  if (result === "fail" && !input?.reason?.trim())
    return fail(`Step ${JSON.stringify(stepName)} cannot fail without a reason: the fix needs to know what the user saw.`)
  const step: AcceptanceStep = {
    ...run.steps[index],
    result,
    ...(input?.evidence?.trim() ? { evidence: input.evidence.trim() } : { evidence: undefined }),
    ...(result === "fail" ? { reason: input?.reason?.trim() } : { reason: undefined }),
  }
  const steps = run.steps.with(index, step)
  const status: RunStatus = steps.some((entry) => entry.result === "fail")
    ? "failed"
    : steps.every((entry) => entry.result === "pass")
      ? "passed"
      : "pending"
  return ok({ ...run, steps, status, finishedAt: status === "pending" ? undefined : Date.now() })
}

/**
 * Defers the run instead of passing it — only with a reason. A deferred run
 * unblocks delivery, but the record still says "deferred", never "passed".
 */
export function defer(run: AcceptanceRun, reason: string): Result<AcceptanceRun> {
  if (!reason.trim()) return fail("Deferring an acceptance run needs a reason: delivery without the user-eyes check must be a named decision.")
  if (run.status === "passed") return fail(`Acceptance run ${run.id} already passed; a passed run is never deferred.`)
  return ok({ ...run, status: "deferred", deferredReason: reason.trim(), finishedAt: Date.now() })
}

/** Delivery is allowed only when the run passed, or was explicitly deferred with a reason. */
export function mayShip(run: AcceptanceRun): boolean {
  return run.status === "passed" || run.status === "deferred"
}

/** Why delivery is blocked, or undefined when the run allows it. */
export function blockingReason(run: AcceptanceRun): string | undefined {
  if (run.status === "passed") return undefined
  if (run.status === "deferred") return undefined
  if (run.status === "failed")
    return `Acceptance run ${run.id} failed: ${run.steps.filter((step) => step.result === "fail").map((step) => `"${step.name}" — ${step.reason}`).join("; ")}`
  const pending = run.steps.filter((step) => step.result === "pending")
  return `Acceptance run ${run.id} is not finished: ${pending.length} step(s) still pending (${pending.map((step) => `"${step.name}"`).join(", ")}).`
}

export function summary(run: AcceptanceRun): string {
  const passed = run.steps.filter((step) => step.result === "pass").length
  return [
    `Acceptance run ${run.id} — scenario "${run.scenario}": ${passed}/${run.steps.length} steps passed, status ${run.status}.`,
    ...(run.status === "deferred" ? [`Deferred: ${run.deferredReason}`] : []),
    ...(run.status === "failed"
      ? [`Failed: ${run.steps.filter((step) => step.result === "fail").map((step) => `"${step.name}" — ${step.reason}`).join("; ")}`]
      : []),
  ].join("\n")
}
