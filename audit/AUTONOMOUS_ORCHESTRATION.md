# Autonomous Orchestration — Dynamic Workflow Stages

Branch: `mcp-role-orchestration`. This document records what existed, the gaps
found, the design that was implemented, and how it integrates with the
existing Orchestra systems instead of replacing them.

## 1. Architecture mapping (what existed before this branch)

| Area | Existing system | State found |
|---|---|---|
| Team lifecycle | `packages/core/src/orchestra.ts` — projects own worker sessions; `createMember`, `dispatch`, `<team-report>` delivery, pending-task tracking, recovery (`recoverPendingTasks`) | Complete; sessions are the execution units |
| Task hand-out | `packages/core/src/tool/plugin/orchestra.ts` (`sessions` tool) — list/read/send/create/set_mode/stop/answer, 6-message delegation rule, per-task MCP limits | Complete; the Orchestrator's only control surface |
| Work categories | Free-text session category labels (`orchestra/category/` KV) grouping the roster | Present, but a label on sessions — not a plan |
| Stages | **Did not exist.** `SessionPlan` is compaction thresholds; DoD `stages:` in `dod.ts` only groups checklist items in a YAML file; one built-in team prompt mentions a "5-stage DoD" as prose | **Gap: no persistent, stateful stage entity** |
| DoD | `packages/core/src/dod.ts` checklist per project | Present; verification lists, not execution state |
| MCP budget enforcement | `packages/core/src/mcp/budget.ts` — one immediate DB transaction, fail-closed, epoch-scoped (merged earlier in PR #35) | Complete |
| Role MCP profiles | `packages/core/src/mcp/role-profiles.ts` (PR #23) | Complete |

**Design decision.** Stages are a *planning and bookkeeping layer over the
existing session/dispatch machinery*, not a second execution engine. Workers
still run as team sessions; dispatch, reports, pending tracking and recovery
are untouched. The stage plan records what the Orchestrator intends, who owns
it, what it depends on, and what evidence closed it.

## 2. Categories vs stages (mandatory distinction)

- **Categories** are dimensions of work (Research, Security, Implementation,
  Testing, …). They are free text, illustrative, never a fixed enum. A stage
  lists the categories it spans (`Stage.categories`); the pre-existing session
  category labels remain a separate roster-grouping concern.
- **Stages** are execution units with identity and state (`Stage` in
  `packages/core/src/stage.ts`): id, name, description, categories, assigned
  role ids, assigned session ids, `dependsOn`, required MCP servers,
  acceptance criteria, status, result/evidence, timestamps.

One stage may span several categories; one category may appear in many
stages; one role may serve many stages; a stage may be served by one role
alone. The Orchestrator decides the number of stages per task — one for a
typo fix, many for a system audit. Nothing in the model fixes a count or a
sequence.

## 3. Dynamic planning

The Orchestrator records a plan through the `sessions` tool:

- `plan` (field `stages`): submit the full plan. Stage ids are stable and
  referenceable by `dependsOn`; omitted ids are generated.
- `stages`: read the current plan as rendered text (also injected into the
  Orchestrator's context on every request, in its own non-cacheable block).
- `stage` (fields `stage`, `status`, `result`): advance one stage.

Planning intelligence stays with the model (what to investigate first, what
parallelizes, which specialists, what verification suffices); the runtime
guarantees the plan is *structurally sound and honestly reported*:

- `validate()` — unique ids, non-empty names, all dependencies known, no
  self-dependency, no cycles (DFS).
- Invalid plans are refused with the exact structural problem.

## 4. Dependencies and parallel execution

- A stage may enter `running` only when **every** stage in `dependsOn` is
  `completed` (enforced in `applyPatch`, not by prompt).
- `actionable()` computes the ready set: planned stages whose dependencies
  are all completed. Independent stages are therefore parallel-safe by
  construction; the existing dispatcher already runs different sessions
  concurrently, and per-session pending tracking prevents double-assignment.
- File/state ownership conflicts between parallel stages remain the
  Orchestrator's planning responsibility (it assigns disjoint scopes in the
  task briefs); the plan records which sessions own which stage so conflicts
  are visible.

## 5. Replanning

`mergePlan(existing, inputs)` semantics:

- Stages the new plan names are replaced by the new definition — **except
  completed stages, which are preserved exactly as recorded** (name,
  acceptance, evidence, timestamps), whether named or omitted. Finished work
  is never rewritten or deleted by a replan.
- Running/blocked/failed stages keep their live status and result under the
  new definition, so replanning mid-flight does not fake a restart.
- Omitted open stages are dropped; cancelled stages may be resurrected to
  planned by naming them again; completed stages may not.
- The merged plan is re-validated as a whole; a replan that would orphan a
  dependency is refused.

A worker discovery therefore becomes: report → Orchestrator adds/adjusts
stages via `plan` → completed evidence survives → work continues without
restarting the workflow.

## 6. Completion rules (evidence-based)

Status machine (`TRANSITIONS` in `stage.ts`):

```
planned   → running | blocked | cancelled
running   → completed | blocked | failed | cancelled
blocked   → planned | running | cancelled
failed    → planned | running | cancelled
cancelled → planned
completed → (terminal, immutable)
```

- `completed` requires prior `running` **and** a non-empty `result` — the
  evidence (report reference, test run, commit). A bare claim is refused by
  the runtime.
- `blocked`/`failed` carry the blocker in `result`.
- `progress().done` — the overall task is complete only when every stage is
  completed or explicitly cancelled **and** at least one stage completed.
  Cancelled counts as settled: an explicitly accepted limitation, recorded.

## 7. Persistence and recovery

- Storage: one KV record per project, `orchestra/stage/<projectID>`, written
  through a JSON round-trip that strips explicit `undefined` optionals;
  reads decode with the Effect Schema for `Stage` (corrupt data reads as an
  empty plan rather than crashing the roster).
- Service surface (`Orchestra` interface): `stages(id)`,
  `planStages(id, inputs)`, `setStage(id, stageID, patch)`; typed
  `Orchestra.StageError`, `ProjectNotFoundError` for unknown projects.
- Because stages live in the same KV store as projects/tasks/reports, they
  survive session resume and process restart exactly like the rest of the
  team state; completed stages are never re-run by recovery (recovery
  concerns pending *tasks*, and stage state is read, not replayed).

## 8. Observability

- The Orchestrator sees the plan (with per-stage readiness: ready / waiting
  on dependencies / status, assignments, MCP needs, acceptance, result) in
  its context each request and via `action stages`.
- Tool outputs state what changed (`Plan saved.`, `Stage updated: …` with the
  full describe line), so the operator reading the main session sees the plan
  evolve without extra UI.

## 9. Verification (see FINAL_VERIFICATION.md)

- Pure model: `packages/core/test/orchestra-stage.test.ts` — 10 tests
  (validation, transitions, dependency gating, evidence requirement,
  completed immutability, replan preservation, progress).
- Service integration: `orchestra-team.test.ts` → "Orchestra workflow
  stages" — plan → gated start refused → evidence-less completion refused →
  completion → KV re-read → replan preservation → typed errors, against the
  real layer.

## Addendum — review round (concurrency and cancellation semantics)

- **Stage writes are serialized per project.** planStages and setStage are
  read-modify-write over one KV record; both now run under a per-project
  KeyedMutex (`stageLocks`, the same mechanism the service already uses for
  project lifecycle state in `mainLocks`). Two concurrent calls can no
  longer read the same snapshot and lose each other's updates; the outcome
  of concurrent calls equals some sequential application. A service-level
  test fires concurrent patches and a replan+patch race and asserts the
  merged result. (Sandbox note: the KV round-trip is synchronous
  in-process, so the harness cannot force the interleaving the lock guards
  against; the lock removes the hazard structurally, matching the
  service's established consistency model.)
- **Cancellation is an accepted limitation, recorded.** A stage may only
  enter `cancelled` with a result note stating why the work is dropped —
  enforced in `applyPatch`, like completion evidence. That is what makes
  `cancelled` counting toward settled progress a conscious decision rather
  than a silent skip.
