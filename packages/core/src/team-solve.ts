export * as TeamSolve from "./team-solve.js"

import { Orchestra } from "@orchestra/schema/orchestra"
import { OrchestraStage } from "./stage.js"

// Team-solve (Memdoor team-solve, the GVS5H method by Lee 2026): six cheap
// workers solve one task — a planner, two parallel ideators, a solver, a
// manager and one repair worker — each in a fresh context, talking only
// through files on disk, while a script running the tests decides success.
//
// This module is the preset: the fixed roster, the stage DAG, the ledger
// files and the judge rule, in one place the code checks against instead of
// a prompt. The roles themselves live in `@orchestra/schema/orchestra` and
// the `team-solve` template recommends them; this module is what makes the
// roster FIXED — the Orchestrator staffs a team-solve project with exactly
// these six roles, in this order, through `Orchestra.rolesForTemplate` —
// and what makes the verdict a test result, never a word or a vote.
//
// Bindings to existing mechanisms (nothing parallel invented):
// - team: the Society's team composition (Б10) via the `team-solve` template;
// - ledger: the project's team notes (`.orchestra/team-notes.md`, see
//   `plugin/team.ts` NOTES) — Memdoor's notes.md — plus the DoD board, the
//   only channels between workers. There is no shared chat: each worker
//   session starts fresh, its brief plus the files on disk are all it has
//   (see the shared team prompt in `plugin/team.ts`);
// - judge: the DoD item's `verification.command`, run by `dod verify`
//   (Б11/Б8) and by the autoloop verify round (Б4). An item becomes DONE
//   only through that command's exit code; see `verdictFromTestRun` below.

/** The six team-solve roles, in pipeline order. */
export const TEAM_SOLVE_ROLES: readonly string[] = [
  "team-planner",
  "ideator-a",
  "ideator-b",
  "team-solver",
  "team-manager",
  "repairer",
]

/** The built-in template id that staffs this preset. */
export const TEAM_SOLVE_TEMPLATE_ID = "team-solve"

/** The ledger file every role reads and writes: Memdoor's notes.md. */
export const TEAM_SOLVE_LEDGER = ".orchestra/team-notes.md"

/** Unique ledger markers the two parallel ideators insert before; each must occur exactly once. */
export const TEAM_SOLVE_MARKERS = {
  proposalA: "<!-- team-solve:proposal-a -->",
  proposalB: "<!-- team-solve:proposal-b -->",
} as const

/** The ledger sections, in pipeline order. */
export const TEAM_SOLVE_LEDGER_SECTIONS: readonly string[] = [
  "Proposal A",
  "Proposal B",
  "Solver decision",
  "Review",
  "Repair",
]

/** Repair rounds after the manager's review: exactly one, as in Memdoor. */
export const TEAM_SOLVE_MAX_REPAIR_ROUNDS = 1

/** The stage ids, in pipeline order. `test` and `verify` are commands, not roles. */
export const TEAM_SOLVE_STAGE_IDS: readonly string[] = [
  "plan",
  "ideate-a",
  "ideate-b",
  "solve",
  "test",
  "review",
  "repair",
  "verify",
]

/** The stage plan: eight steps over the six roles, as `StageInput`s the sessions tool can merge. */
export const TEAM_SOLVE_STAGES: readonly OrchestraStage.StageInput[] = [
  {
    id: "plan",
    name: "Plan",
    description: "Planner: decomposition, correctness requirements, candidate approaches, and the ledger setup.",
    categories: ["Planning"],
    roles: ["team-planner"],
    acceptance: "plan written and both ledger markers occur exactly once in .orchestra/team-notes.md",
  },
  {
    id: "ideate-a",
    name: "Ideate A — direct proof",
    description: "Ideator A: the most direct algorithm that can be proved to meet the task, appended to Proposal A.",
    categories: ["Planning"],
    roles: ["ideator-a"],
    dependsOn: ["plan"],
    acceptance: "Proposal A is on disk in the ledger, before its marker, with pseudocode, invariant and complexity",
  },
  {
    id: "ideate-b",
    name: "Ideate B — other family",
    description: "Ideator B: one alternative proposal from a different family of technique, appended to Proposal B.",
    categories: ["Planning"],
    roles: ["ideator-b"],
    dependsOn: ["plan"],
    acceptance: "Proposal B is on disk in the ledger, before its marker, with pseudocode, correctness reasoning and tradeoffs",
  },
  {
    id: "solve",
    name: "Solve",
    description: "Solver: picks one proposal, justifies the choice in the ledger, writes the complete solution.",
    categories: ["Build"],
    roles: ["team-solver"],
    dependsOn: ["ideate-a", "ideate-b"],
    acceptance: "solution written and run once on a sample; the choice is justified in the ledger",
  },
  {
    id: "test",
    name: "Test (command)",
    description: "Command: run the DoD verification command, capture its output and exit status; never fails the run itself.",
    categories: ["Quality"],
    roles: [],
    dependsOn: ["solve"],
    acceptance: "captured test output and exit status are on disk",
  },
  {
    id: "review",
    name: "Review",
    description: "Manager: judges the captured test output and writes the review plus concrete repair instructions, or records that none are needed.",
    categories: ["Quality"],
    roles: ["team-manager"],
    dependsOn: ["test"],
    acceptance: "review and repair instructions (or a no-repair record) are on disk in the ledger",
  },
  {
    id: "repair",
    name: "Repair (one round)",
    description: "Repair worker: at most one round — fixes the solution per the manager's instructions, or leaves it unchanged when the tests already passed.",
    categories: ["Build"],
    roles: ["repairer"],
    dependsOn: ["review"],
    acceptance: "solution fixed per the instructions, or unchanged with a no-repair-needed record",
  },
  {
    id: "verify",
    name: "Verify — the judge (command)",
    description: "Command: run the DoD verification command again; its exit code is the verdict.",
    categories: ["Quality"],
    roles: [],
    dependsOn: ["repair"],
    acceptance: "verification command exits 0",
  },
]

/** Builds the preset's stages (planned, validated) for the sessions tool. */
export function buildStages(now: number): OrchestraStage.Result<readonly OrchestraStage.Stage[]> {
  return OrchestraStage.mergePlan([], TEAM_SOLVE_STAGES, now, () => `team-solve-${now}`)
}

/** The judge's verdict: what a test run decided. */
export interface TestRun {
  /** The verification command's exit code: 0 is pass, anything else is fail. */
  readonly exitCode: number
  /** How many checks failed; 0 when the command reports none. */
  readonly failures: number
}

export interface Verdict {
  readonly passed: boolean
  readonly reason: string
}

/**
 * The verdict from a test run — and ONLY from a test run. The input carries
 * no worker claim, no vote and no report text, so by construction no word
 * from any agent can pass or fail a task: only the verification command's
 * exit code decides, exactly as `dod verify` records it. A missing or
 * negative exit code is a fail, never a pass.
 */
export function verdictFromTestRun(run: TestRun): Verdict {
  if (run.exitCode !== 0)
    return {
      passed: false,
      reason: `Verification command exited ${run.exitCode} with ${run.failures} failing check(s) — not done.`,
    }
  if (run.failures !== 0)
    return {
      passed: false,
      reason: `Verification command exited 0 but reports ${run.failures} failing check(s) — not done.`,
    }
  return { passed: true, reason: "Verification command exited 0 with no failing checks — done." }
}

/**
 * Structural checks for a staffed preset: exactly the six roles, every one
 * registered in the schema, the stage DAG valid, the two ideators parallel
 * after the plan, the solver after both, the judge last with no role and no
 * dependency after it, and exactly one repair stage. Returns the first
 * problem, or undefined when the preset is sound.
 */
export function validatePreset(): string | undefined {
  const registered = new Set(Orchestra.roles.map((role) => role.id))
  for (const id of TEAM_SOLVE_ROLES) {
    if (!registered.has(id)) return `Team-solve role "${id}" is not registered.`
  }
  const template = Orchestra.templates.find((item) => item.id === TEAM_SOLVE_TEMPLATE_ID)
  if (!template) return `Team-solve template "${TEAM_SOLVE_TEMPLATE_ID}" is missing.`
  if (template.roles?.join(",") !== TEAM_SOLVE_ROLES.join(","))
    return `Team-solve template roles are ${template.roles?.join(",") ?? "unset"}; expected ${TEAM_SOLVE_ROLES.join(",")}.`
  const stages = buildStages(Date.now())
  if (!stages.ok) return `Team-solve stages are invalid: ${stages.message}`
  const byID = new Map(stages.value.map((stage) => [stage.id, stage]))
  const ideateA = byID.get("ideate-a")
  const ideateB = byID.get("ideate-b")
  if (ideateA?.dependsOn.join(",") !== "plan" || ideateB?.dependsOn.join(",") !== "plan")
    return "The two ideators must both depend only on the plan, so they run in parallel."
  if (byID.get("solve")?.dependsOn.join(",") !== "ideate-a,ideate-b")
    return "The solver must wait for both ideators."
  if (byID.get("verify")?.dependsOn.join(",") !== "repair" || (byID.get("verify")?.roles.length ?? 0) !== 0)
    return "The judge (verify) must be a command after the repair, with no role."
  const repairs = stages.value.filter((stage) => stage.id === "repair")
  if (repairs.length !== 1) return `Expected exactly one repair stage, found ${repairs.length}.`
  return undefined
}
