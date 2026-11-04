export * as OrchestraStage from "./stage.js"

import { Schema } from "effect"

// Dynamic workflow stages for an Orchestra project.
//
// A stage is a persistent unit of planned work owned by the project's main
// session (the Orchestrator). It is deliberately NOT a second execution
// engine: sessions still do the work and `Orchestra.dispatch` still delivers
// tasks and reports. A stage records what the Orchestrator planned — the
// work categories it covers, the roles and sessions assigned, its
// dependencies, the MCP servers it needs, and its acceptance criteria — and
// tracks that plan's state across restarts and replanning.
//
// Categories and stages are different concepts: a category is a dimension of
// work ("Security", "Testing"), a stage is an execution unit that may cover
// several categories, and a category may recur across stages. Categories are
// free text on purpose; the Orchestrator names the dimensions its task has.
//
// This module is the pure model: validation, status transitions, readiness
// and progress. The Orchestra service persists the records in KV and the
// sessions tool exposes them; every rule that protects completed work or
// dependency order lives here, where it is testable without services.

export const Status = Schema.Literals(["planned", "running", "blocked", "failed", "completed", "cancelled"])
export type Status = Schema.Schema.Type<typeof Status>

export const STATUSES: readonly Status[] = [...Status.literals]

export const Stage = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** Work categories (dimensions) this stage covers; free text, e.g. ["Research", "Security"]. */
  categories: Schema.Array(Schema.String),
  /** Role ids assigned to this stage. */
  roles: Schema.Array(Schema.String),
  /** Worker session ids doing this stage's work. */
  sessionIDs: Schema.Array(Schema.String),
  /** Stage ids that must be completed before this stage may run. */
  dependsOn: Schema.Array(Schema.String),
  /** MCP servers this stage requires; allocation itself stays with the sessions tool's per-task limits. */
  mcp: Schema.Array(Schema.String),
  /** Acceptance criteria: what evidence completes this stage. */
  acceptance: Schema.String,
  status: Status,
  /** Evidence for the current status: a report reference for completed, the blocker for blocked/failed. */
  result: Schema.optionalKey(Schema.String),
  created: Schema.Number,
  updated: Schema.Number,
  completed: Schema.optionalKey(Schema.Number),
})
export type Stage = Schema.Schema.Type<typeof Stage>

/** What the Orchestrator supplies when planning a stage; ids are assigned when omitted. */
export interface StageInput {
  readonly id?: string
  readonly name: string
  readonly description?: string
  readonly categories?: readonly string[]
  readonly roles?: readonly string[]
  readonly sessionIDs?: readonly string[]
  readonly dependsOn?: readonly string[]
  readonly mcp?: readonly string[]
  readonly acceptance?: string
}

/** A patch to one stage. A status change is validated as a transition; the rest edits plan fields. */
export interface StagePatch {
  readonly status?: Status
  readonly result?: string
  readonly name?: string
  readonly description?: string
  readonly categories?: readonly string[]
  readonly roles?: readonly string[]
  readonly sessionIDs?: readonly string[]
  readonly dependsOn?: readonly string[]
  readonly mcp?: readonly string[]
  readonly acceptance?: string
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (message: string): Result<never> => ({ ok: false, message })

const clean = (values: readonly string[] | undefined) =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]

/** Structural checks that hold for any plan: unique ids, known dependencies, no dependency cycles. */
export function validate(stages: readonly Stage[]): string | undefined {
  const ids = new Set<string>()
  for (const stage of stages) {
    if (!stage.id.trim()) return "A stage has an empty id."
    if (ids.has(stage.id)) return `Duplicate stage id "${stage.id}".`
    ids.add(stage.id)
    if (!stage.name.trim()) return `Stage "${stage.id}" has an empty name.`
  }
  for (const stage of stages) {
    for (const dependency of stage.dependsOn) {
      if (dependency === stage.id) return `Stage "${stage.id}" depends on itself.`
      if (!ids.has(dependency)) return `Stage "${stage.id}" depends on unknown stage "${dependency}".`
    }
  }
  // Cycle check: depth-first over dependsOn, marking the current path.
  const byID = new Map(stages.map((stage) => [stage.id, stage]))
  const state = new Map<string, "visiting" | "done">()
  const visit = (id: string, path: readonly string[]): string | undefined => {
    if (state.get(id) === "done") return undefined
    if (state.get(id) === "visiting") return `Dependency cycle: ${[...path, id].join(" -> ")}.`
    state.set(id, "visiting")
    for (const dependency of byID.get(id)?.dependsOn ?? []) {
      const problem = visit(dependency, [...path, id])
      if (problem) return problem
    }
    state.set(id, "done")
    return undefined
  }
  for (const stage of stages) {
    const problem = visit(stage.id, [])
    if (problem) return problem
  }
  return undefined
}

/**
 * Merge a fresh plan into the stored one (replanning). Stages the new plan
 * names are replaced by it, stages it omits are dropped — except completed
 * stages, which are always preserved exactly as recorded: replanning never
 * rewrites or deletes finished work and its evidence. A completed stage may
 * not be redefined by a later plan either.
 */
export function mergePlan(
  existing: readonly Stage[],
  inputs: readonly StageInput[],
  now: number,
  makeID: () => string,
): Result<readonly Stage[]> {
  const completed = new Map(existing.filter((stage) => stage.status === "completed").map((stage) => [stage.id, stage]))
  const merged: Stage[] = []
  for (const input of inputs) {
    const name = input.name?.trim()
    if (!name) return fail("Every stage needs a name.")
    const id = input.id?.trim() || makeID()
    if (completed.has(id)) {
      // The plan may keep a completed stage by naming it, but not redefine it.
      merged.push(completed.get(id)!)
      completed.delete(id)
      continue
    }
    if (merged.some((stage) => stage.id === id)) return fail(`Duplicate stage id "${id}" in the plan.`)
    const prior = existing.find((stage) => stage.id === id)
    merged.push({
      id,
      name,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      categories: clean(input.categories),
      roles: clean(input.roles),
      sessionIDs: clean(input.sessionIDs),
      dependsOn: clean(input.dependsOn),
      mcp: clean(input.mcp),
      acceptance: input.acceptance?.trim() ?? "",
      status: prior?.status === "running" || prior?.status === "blocked" || prior?.status === "failed" ? prior.status : "planned",
      ...(prior?.result ? { result: prior.result } : {}),
      created: prior?.created ?? now,
      updated: now,
    })
  }
  // Completed stages the new plan did not name stay on the record.
  for (const stage of completed.values()) merged.push(stage)
  const problem = validate(merged)
  if (problem) return fail(problem)
  return ok(merged)
}

const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  planned: ["running", "blocked", "cancelled"],
  running: ["completed", "blocked", "failed", "cancelled"],
  blocked: ["planned", "running", "cancelled"],
  failed: ["planned", "running", "cancelled"],
  completed: [],
  cancelled: ["planned"],
}

/**
 * Apply a patch to one stage, enforcing the transition rules:
 * - a stage may start (running) only when every dependency is completed;
 * - a stage may complete only from running, and only with a result note as
 *   its evidence — a bare claim of completion is not accepted;
 * - completed stages are immutable: neither their status nor their plan
 *   fields change after the fact;
 * - plan fields of any other stage may be edited freely (replanning), but
 *   the merged plan must stay structurally valid.
 */
export function applyPatch(
  stages: readonly Stage[],
  id: string,
  patch: StagePatch,
  now: number,
): Result<readonly Stage[]> {
  const stage = stages.find((item) => item.id === id)
  if (!stage) return fail(`Unknown stage "${id}". Stages: ${stages.map((item) => item.id).join(", ") || "none"}.`)
  if (stage.status === "completed")
    return fail(`Stage "${id}" is completed; completed work and its evidence are preserved and cannot be changed.`)
  let next: Stage = {
    ...stage,
    ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim() || undefined } : {}),
    ...(patch.categories !== undefined ? { categories: clean(patch.categories) } : {}),
    ...(patch.roles !== undefined ? { roles: clean(patch.roles) } : {}),
    ...(patch.sessionIDs !== undefined ? { sessionIDs: clean(patch.sessionIDs) } : {}),
    ...(patch.dependsOn !== undefined ? { dependsOn: clean(patch.dependsOn) } : {}),
    ...(patch.mcp !== undefined ? { mcp: clean(patch.mcp) } : {}),
    ...(patch.acceptance !== undefined ? { acceptance: patch.acceptance.trim() } : {}),
    ...(patch.result !== undefined ? { result: patch.result.trim() || undefined } : {}),
    updated: now,
  }
  if (patch.status !== undefined && patch.status !== stage.status) {
    if (!TRANSITIONS[stage.status].includes(patch.status))
      return fail(`Stage "${id}" cannot move from ${stage.status} to ${patch.status}.`)
    if (patch.status === "running") {
      const byID = new Map(stages.map((item) => [item.id, item]))
      const open = next.dependsOn.filter((dependency) => byID.get(dependency)?.status !== "completed")
      if (open.length > 0)
        return fail(`Stage "${id}" cannot start: dependencies not completed: ${open.join(", ")}.`)
    }
    if (patch.status === "completed" && !next.result)
      return fail(`Stage "${id}" cannot be completed without a result note: state the evidence (what was verified, where the report or artifact is).`)
    next = {
      ...next,
      status: patch.status,
      ...(patch.status === "completed" ? { completed: now } : {}),
      ...(patch.status === "planned" || patch.status === "running" ? { completed: undefined } : {}),
    }
  }
  const merged = stages.map((item) => (item.id === id ? next : item))
  const problem = validate(merged)
  if (problem) return fail(problem)
  return ok(merged)
}

/** Stages that may start now: planned, with every dependency completed. */
export function actionable(stages: readonly Stage[]): readonly Stage[] {
  const byID = new Map(stages.map((stage) => [stage.id, stage]))
  return stages.filter(
    (stage) => stage.status === "planned" && stage.dependsOn.every((dependency) => byID.get(dependency)?.status === "completed"),
  )
}

/** Whether a stage's dependencies are all completed (it is unblocked, whatever its status). */
export function unblocked(stages: readonly Stage[], stage: Stage) {
  const byID = new Map(stages.map((item) => [item.id, item]))
  return stage.dependsOn.every((dependency) => byID.get(dependency)?.status === "completed")
}

export interface Progress {
  readonly total: number
  readonly completed: number
  readonly cancelled: number
  readonly running: number
  readonly blocked: number
  readonly failed: number
  readonly planned: number
  /** Every stage settled, with at least one completed: the workflow's work is done. */
  readonly done: boolean
}

/** Aggregate state of a plan. Cancelled counts as settled: an explicitly accepted limitation (§ completion rules). */
export function progress(stages: readonly Stage[]): Progress {
  const count = (status: Status) => stages.filter((stage) => stage.status === status).length
  const completed = count("completed")
  const cancelled = count("cancelled")
  return {
    total: stages.length,
    completed,
    cancelled,
    running: count("running"),
    blocked: count("blocked"),
    failed: count("failed"),
    planned: count("planned"),
    done: stages.length > 0 && completed + cancelled === stages.length && completed > 0,
  }
}

/** One stage as a single report line, with its readiness computed against the whole plan. */
export function describe(stages: readonly Stage[], stage: Stage): string {
  const readiness =
    stage.status === "planned" ? (unblocked(stages, stage) ? "ready" : "waiting on dependencies") : stage.status
  return [
    `${stage.id} "${stage.name}" [${readiness}]`,
    ...(stage.categories.length > 0 ? [`categories: ${stage.categories.join(", ")}`] : []),
    ...(stage.roles.length > 0 ? [`roles: ${stage.roles.join(", ")}`] : []),
    ...(stage.sessionIDs.length > 0 ? [`sessions: ${stage.sessionIDs.join(", ")}`] : []),
    ...(stage.dependsOn.length > 0 ? [`depends on: ${stage.dependsOn.join(", ")}`] : []),
    ...(stage.mcp.length > 0 ? [`mcp: ${stage.mcp.join(", ")}`] : []),
    ...(stage.acceptance ? [`acceptance: ${stage.acceptance}`] : []),
    ...(stage.result ? [`result: ${stage.result}`] : []),
  ].join(" · ")
}

/** The whole plan as the Orchestrator sees it in its context and in tool output. */
export function render(stages: readonly Stage[]): string {
  if (stages.length === 0) return "No workflow stages planned yet."
  const summary = progress(stages)
  const lines = stages.map((stage) => `- ${describe(stages, stage)}`)
  return [
    `Workflow stages: ${summary.completed}/${summary.total} completed${summary.cancelled ? `, ${summary.cancelled} cancelled` : ""}${summary.running ? `, ${summary.running} running` : ""}${summary.blocked ? `, ${summary.blocked} blocked` : ""}${summary.failed ? `, ${summary.failed} failed` : ""}.`,
    ...lines,
  ].join("\n")
}
