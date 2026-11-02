export * as DreamTeamTool from "./dream-team.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import type { Agent } from "../../agent.js"

// Dream Team: assemble a team for a task, run it through subagents, and
// do not call the task done until every acceptance criterion passes.
//
// This plugin deliberately does NOT contain its own scheduler. Orchestra
// already has a tested one: the subagent tool spawns child sessions,
// runs them to completion (foreground) or in the background, and reports
// their output. The Dream Team adds the two things that tool lacks:
//   1. assemble — a deterministic team for a task, built from the agents
//      that actually exist (never invented), with a role, a mission, and
//      an order for each member, plus the acceptance criteria that define
//      "100% done";
//   2. verify — a gate. The orchestrator feeds it the criteria and the
//      evidence for each one; it reports a percentage and the exact gaps.
//      Until it reports 100%, the task is not done: re-spawn the role
//      that owns each gap and verify again.
//
// "Highest-tech tools" is part of the contract, not a slogan: every role
// mission names the tools it must use — codegraph/symbols and LSP for
// navigation instead of blind grep, the real test runner and linter for
// verification instead of a claim that it works, websearch for current
// documentation instead of memory — and parallel roles run as background
// subagents instead of one after another.

export interface DreamAgent {
  id: string
  name: string
  description?: string
  mode: string
  hidden: boolean
}

export interface DreamRole {
  role: string
  agent: string
  mission: string
}

export interface DreamTeamPlan {
  task: string
  roles: DreamRole[]
  phases: string[]
  criteria: string[]
}

const ROLE_MISSIONS: Array<{ role: string; mission: string }> = [
  {
    role: "architect",
    mission:
      "Break the task into subtasks, decide the approach, and write down the acceptance criteria. Use codegraph/symbols and LSP to map the existing code before proposing anything; do not guess the codebase layout.",
  },
  {
    role: "builder",
    mission:
      "Implement the subtasks from the architect's plan. Navigate with codegraph/symbols and LSP, edit precisely, and never claim a change works without running it.",
  },
  {
    role: "tester",
    mission:
      "Prove the work: write or extend tests, run the real test runner, the build, and the linter, and report the exact commands and their results, pass or fail.",
  },
  {
    role: "reviewer",
    mission:
      "Review the changes for correctness, security, and fit with the plan. Use websearch for current documentation when an API is in doubt. List every finding; silence means approval, not a skipped review.",
  },
  {
    role: "finisher",
    mission:
      "Fix every reviewer finding, update documentation for any changed public behavior, and run the full verification once more. The task is done only when dream_team_verify reports 100%.",
  },
]

export const DEFAULT_CRITERIA = [
  "The task's requirements are implemented, not partially or as a stub.",
  "The build passes.",
  "The tests pass (new or extended tests cover the change).",
  "The linter is clean for the changed files.",
  "Reviewer findings are resolved, not ignored.",
]

export function assembleTeam(task: string, agents: DreamAgent[]): DreamTeamPlan {
  const available = agents
    .filter((agent) => agent.mode !== "primary" && !agent.hidden)
    .toSorted((a, b) => a.id.localeCompare(b.id))
  const roles: DreamRole[] = ROLE_MISSIONS.map((role, index) => {
    const agent = available.length > 0 ? available[index % available.length] : undefined
    return {
      role: role.role,
      agent: agent ? `${agent.id} (${agent.name})` : "the orchestrator itself (no subagent configured for this role)",
      mission: role.mission,
    }
  })
  return {
    task,
    roles,
    phases: [
      "1. Architect first, alone: plan and acceptance criteria.",
      "2. Builder and tester in parallel as background subagents; the tester works against the builder's branches as they land.",
      "3. Reviewer after the build and tests pass.",
      "4. Finisher fixes every finding, then the whole verification runs again.",
      "5. dream_team_verify gate: repeat phases 2-4 for any gap until it reports 100%.",
    ],
    criteria: [...DEFAULT_CRITERIA],
  }
}

export function formatPlan(plan: DreamTeamPlan): string {
  const lines = [
    `Dream team for: ${plan.task}`,
    "",
    "Team (roles are assigned to agents that actually exist; one agent may hold several roles when few are configured):",
    ...plan.roles.map((role) => `- ${role.role}: ${role.agent} — ${role.mission}`),
    "",
    "Phases (spawn each role with the subagent tool; parallel roles use background=true):",
    ...plan.phases,
    "",
    "Acceptance criteria — 100% means every one of these passes, verified by dream_team_verify:",
    ...plan.criteria.map((criterion) => `- [ ] ${criterion}`),
    "",
    "Rules: never report the task done before the verify gate says 100%. Never invent an agent, a test result, or a build result — report only what the tools actually returned.",
  ]
  return lines.join("\n")
}

export interface ChecklistItem {
  criterion: string
  status: "pass" | "fail"
  evidence: string
}

export interface VerifyReport {
  total: number
  passed: number
  percent: number
  gaps: ChecklistItem[]
  report: string
}

export function verifyChecklist(items: ChecklistItem[]): VerifyReport {
  const total = items.length
  const passed = items.filter((item) => item.status === "pass").length
  const percent = total === 0 ? 0 : Math.round((passed / total) * 100)
  const gaps = items.filter((item) => item.status !== "pass")
  const report =
    total === 0
      ? "NOT DONE (0%): no acceptance criteria were checked. Run the verification with real evidence for every criterion."
      : percent === 100
        ? "DONE (100%): every acceptance criterion passes with evidence. The task may be reported complete."
        : [
            `NOT DONE (${percent}%): ${passed} of ${total} criteria pass.`,
            "Gaps — re-spawn the role that owns each gap with the subagent tool, fix it, then verify again:",
            ...gaps.map((gap) => `- ${gap.criterion} — evidence: ${gap.evidence || "(none given)"}`),
          ].join("\n")
  return { total, passed, percent, gaps, report }
}

const Output = Schema.Struct({ output: Schema.String })
type Output = typeof Output.Type

function text(output: string): Output {
  return { output }
}

const ChecklistItemSchema = Schema.Struct({
  criterion: Schema.String,
  status: Schema.Literals(["pass", "fail"]),
  evidence: Schema.String,
})

export const Plugin = {
  id: "orchestra.tool.dream-team",
  effect: Effect.fn("DreamTeamTool.Plugin")(function* (ctx: Context) {
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "dream_team_assemble",
        description:
          "Assemble a dream team for a task: roles assigned to agents that actually exist, phases, and the acceptance criteria that define 100% done. Spawn each role with the subagent tool afterwards; do not report the task done before dream_team_verify reports 100%.",
        input: Schema.Struct({ task: Schema.String }),
        output: Output,
        options: { codemode: false },
        execute: (input) =>
          Effect.gen(function* () {
            const listed = yield* ctx.agent.list()
            const agents: DreamAgent[] = listed.data.map((agent) => ({
              id: agent.id,
              name: agent.name,
              description: agent.description,
              mode: agent.mode,
              hidden: agent.hidden,
            }))
            return text(formatPlan(assembleTeam(input.task, agents)))
          }),
      })

      editor.add({
        name: "dream_team_verify",
        description:
          "Gate for 100% done: check acceptance criteria against real evidence (test runs, build output, lint output, review findings). Returns a percentage and the exact gaps. If it is not 100%, fix the gaps and verify again; never report completion before 100%.",
        input: Schema.Struct({ items: Schema.Array(ChecklistItemSchema) }),
        output: Output,
        options: { codemode: false },
        execute: (input) =>
          Effect.sync(() =>
            text(
              verifyChecklist(
                input.items.map((item) => ({
                  criterion: item.criterion,
                  status: item.status,
                  evidence: item.evidence,
                })),
              ).report,
            ),
          ),
      })
    })
  }),
}
