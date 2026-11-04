# Dream Team Retirement — one orchestration system, not two

Date: 2026-11-04. Base: `main` @ `9ffabbd`.

## What was removed

- `packages/core/src/tool/plugin/dream-team.ts` — deleted.
- The `dream_team_assemble` and `dream_team_verify` tools — no longer
  registered or advertised (registration in `packages/core/src/plugin/internal.ts` removed).
- `packages/core/test/dream-team.test.ts` — replaced by
  `packages/core/test/stage-verify.test.ts` (see below).

The Dream Team duplicated the Orchestra system: it assembled a fixed
five-role team (architect/builder/tester/reviewer/finisher) in a fixed
five-phase order around the generic `subagent` tool, while Orchestra
already has dynamic role selection from the real role registry, `sessions`
task dispatch with per-task permissions and MCP budgets, dynamic workflow
stages with dependencies, worker reports and evidence-based completion.

## What was genuinely unique — and where it lives now

The one capability the stage system lacked was `dream_team_verify`'s
evidence gate: scoring acceptance criteria so the gate cannot be gamed —
a pass requires non-empty evidence, duplicates count once, a missing
criterion is a gap, and items outside the plan's criteria are ignored.

That logic was integrated into the stage engine before the old entry point
was removed:

- `OrchestraStage.verifyAcceptance(criteria, items)` in
  `packages/core/src/stage.ts` — the same anti-gaming rules, but the
  criteria are the **caller's own** (a task's criteria, or a stage's),
  never a fixed universal five-item checklist.
- Exposed as the `sessions` tool action `verify`
  (`criteria` + `items` inputs), described in the tool's workflow guidance
  as the completion gate. Stage completion already required result
  evidence; `verify` adds criterion-by-criterion scoring on top.

The fixed team/phases half of Dream Team was NOT ported: dynamic role
selection and stage planning supersede it, and porting it would have kept
the second orchestration system alive.

## What was not touched

`subagent`, `sessions`, role management (`team_forge`), task reporting,
stage planning and evidence tracking are unchanged in behaviour.

## Tests

`stage-verify.test.ts` ports the old gate's cases to `verifyAcceptance`
(100% only with evidence for every criterion; subset is not 100%; a pass
without evidence does not count and duplicates do not inflate; extras are
ignored; no criteria is not done) and adds the dynamic property: the
criteria are the caller's own, scored out of however many there are.
