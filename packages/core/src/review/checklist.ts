export * as ReviewChecklist from "./checklist.js"

import type { Dod } from "../dod.js"

// Foreign checklist review (idea #7): a finished task is always checked by
// a group that did NOT do it — item by item from the DoD, not by taste.
// The reviewer marks each checklist step pass or fail; the result is
// recorded, and a task with a failed step is not done.
//
// This module is the MECHANISM. The runtime agent does the actual checking
// (reading the code, running the checks); this module assigns the foreign
// reviewer, builds the checklist from the DoD board through its PUBLIC API
// only (`Dod.Status` — `dod.ts` is owned by another slice and is never
// edited here), records the marks, and computes the verdict.
//
// Rules:
// - the reviewer group must differ from the author group; assigning the
//   author's own group is refused;
// - every step needs a mark: a verdict of "pass" requires every step
//   passed; one failed step fails the whole review; anything unmarked is
//   "pending", never an assumed pass;
// - marks are evidence, not opinion: a pass/fail may carry a reference
//   (a test run, a file:line), and the record keeps it.

export const StepResult = ["pass", "fail", "pending"] as const
export type StepResult = (typeof StepResult)[number]

export const Verdict = ["pass", "fail", "pending"] as const
export type Verdict = (typeof Verdict)[number]

export interface ChecklistStep {
  readonly index: number
  readonly text: string
  readonly result: StepResult
  /** Reference for the mark: a test run, a file:line, a command output. */
  readonly evidence?: string
  /** Why the step failed, when it did. */
  readonly reason?: string
}

export interface ChecklistReview {
  readonly id: string
  readonly itemId: string
  readonly itemTitle: string
  /** The group that did the work. */
  readonly authorGroup: string
  /** The group that checks it — always a different group. */
  readonly reviewerGroup: string
  readonly steps: readonly ChecklistStep[]
  readonly createdAt: number
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (message: string): Result<never> => ({ ok: false, message })

let counter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

/**
 * Picks the reviewing group: the first group in roster order that is not the
 * author's group. Deterministic on purpose — the assignment must be
 * reproducible from the roster, not a coin flip nobody can replay.
 */
export function assignReviewer(input: { readonly authorGroup: string; readonly groups: readonly string[] }): Result<{
  readonly reviewerGroup: string
}> {
  const author = input.authorGroup.trim()
  if (!author) return fail("A checklist review needs the author group to review against.")
  const reviewerGroup = input.groups.map((group) => group.trim()).find((group) => group !== "" && group !== author)
  if (reviewerGroup === undefined)
    return fail(`No foreign reviewer exists: every group in the roster is the author group ${JSON.stringify(author)}.`)
  return ok({ reviewerGroup })
}

/** Opens a checklist review of one DoD item, with one step per checklist line. */
export function startChecklist(input: {
  readonly id?: string
  readonly itemId: string
  readonly itemTitle: string
  readonly authorGroup: string
  readonly reviewerGroup: string
  readonly steps: readonly string[]
}): Result<ChecklistReview> {
  const author = input.authorGroup.trim()
  const reviewer = input.reviewerGroup.trim()
  if (!input.itemId.trim()) return fail("A checklist review needs the DoD item it checks.")
  if (!author || !reviewer) return fail("A checklist review needs both the author group and the reviewer group.")
  if (author === reviewer)
    return fail(`The reviewer must be a foreign group: ${JSON.stringify(reviewer)} also did the work.`)
  const steps = input.steps.map((step) => step.trim()).filter(Boolean)
  if (steps.length === 0) return fail(`DoD item ${input.itemId} has no checklist steps to review against.`)
  return ok({
    id: input.id?.trim() || nextId("checklist"),
    itemId: input.itemId.trim(),
    itemTitle: input.itemTitle.trim(),
    authorGroup: author,
    reviewerGroup: reviewer,
    steps: steps.map((text, index) => ({ index: index + 1, text, result: "pending" as const })),
    createdAt: Date.now(),
  })
}

/**
 * Builds the checklist for one board item from the DoD status — the board's
 * step lines as written (`board.steps`), nothing else. Uses only the public
 * `Dod.Status` shape; it never reads or writes `dod.yaml` itself.
 */
export function fromDod(
  board: Dod.Status,
  itemId: string,
  input: { readonly authorGroup: string; readonly reviewerGroup: string },
): Result<ChecklistReview> {
  if (board.type !== "ready") return fail(`The DoD board is not ready (${board.type}); there is no checklist to review.`)
  const item = board.items.find((entry) => entry.id === itemId)
  if (!item) return fail(`The DoD has no item ${itemId}.`)
  return startChecklist({
    itemId: item.id,
    itemTitle: item.what,
    authorGroup: input.authorGroup,
    reviewerGroup: input.reviewerGroup,
    steps: board.steps?.get(item.id) ?? [],
  })
}

/** Marks one checklist step pass or fail. A fail needs a reason; a mark may carry evidence. */
export function markStep(
  review: ChecklistReview,
  stepIndex: number,
  result: Exclude<StepResult, "pending">,
  input?: { readonly evidence?: string; readonly reason?: string },
): Result<ChecklistReview> {
  const index = review.steps.findIndex((step) => step.index === stepIndex)
  if (index < 0) return fail(`Checklist review ${review.id} has no step ${stepIndex}.`)
  if (result === "fail" && !input?.reason?.trim())
    return fail(`Step ${stepIndex} cannot fail without a reason: the author needs to know what is wrong.`)
  const step: ChecklistStep = {
    ...review.steps[index],
    result,
    ...(input?.evidence?.trim() ? { evidence: input.evidence.trim() } : { evidence: undefined }),
    ...(result === "fail" ? { reason: input?.reason?.trim() } : { reason: undefined }),
  }
  return ok({ ...review, steps: review.steps.with(index, step) })
}

/** pass only when every step passed; fail when any step failed; pending while any step is unmarked. */
export function verdict(review: ChecklistReview): Verdict {
  if (review.steps.some((step) => step.result === "fail")) return "fail"
  if (review.steps.some((step) => step.result === "pending")) return "pending"
  return "pass"
}

export function failedSteps(review: ChecklistReview): readonly ChecklistStep[] {
  return review.steps.filter((step) => step.result === "fail")
}

export function pendingSteps(review: ChecklistReview): readonly ChecklistStep[] {
  return review.steps.filter((step) => step.result === "pending")
}

export function summary(review: ChecklistReview): string {
  const passed = review.steps.filter((step) => step.result === "pass").length
  return [
    `Checklist review ${review.id} of ${review.itemId} "${review.itemTitle}" — ${review.reviewerGroup} checking ${review.authorGroup}'s work:`,
    `${passed}/${review.steps.length} steps passed, ${failedSteps(review).length} failed, ${pendingSteps(review).length} unmarked. Verdict: ${verdict(review)}.`,
    ...(failedSteps(review).length > 0
      ? [`Failed: ${failedSteps(review).map((step) => `#${step.index} "${step.text}" — ${step.reason}`).join("; ")}`]
      : []),
  ].join("\n")
}
