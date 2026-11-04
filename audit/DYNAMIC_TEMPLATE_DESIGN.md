# Dynamic Template Design — templates describe work, the Orchestrator decides the team

Date: 2026-11-04. Base: `main` @ `9ffabbd`.

## The mental model

- **Templates describe the type of work.** A template answers "what kind of
  task is this, what expertise might it need, what does done look like here?"
- **The Orchestrator decides which people are needed.** How many workers,
  which roles, what runs in parallel, when to add or stop a specialist —
  all decided per task, from the actual work.
- **Stages describe executable work and dependencies.** Planned dynamically
  with the `sessions` actions `plan`/`stages`/`stage`; as many as the task
  needs; completion requires evidence; acceptance is scored with `verify`.
- **MCP assignments belong to individual task sessions.** See
  `SESSION_MCP_ASSIGNMENTS.md`. Global availability never grants access.

## The contract change (`packages/schema/src/orchestra.ts`)

`TemplateSpec` gained one optional field:

- `roles?: string[]` — **recommended roles**: role ids the Orchestrator may
  draw on when the task needs them. Suggestions, never a roster.

`members` is unchanged in shape and meaning for stored data: it is the
legacy explicit roster. It remains authoritative **only** for templates the
operator saved (origin `edited`/`custom`) — their fixed team is a deliberate
choice and is preserved exactly. For built-ins, `members` is retained data
(older displays and the legacy records keep working), not a roster to open.

Stored templates round-trip `roles` automatically (`StoredTemplate` spreads
`TemplateSpec.fields`); `requireTemplate` validates that every recommended
role id resolves to a real role and passes the hints through. Role deletion
is blocked while any template references the role by roster **or** by hint.

## Project creation (`Orchestra.create` in `packages/core/src/orchestra.ts`)

- Built-in template (origin `builtin`): the project record stores the
  template id (so its playbook applies) and **no team plan is written** —
  the project opens with only its main Orchestrator session. The
  Orchestrator creates workers lazily via `sessions create`, reusing
  suitable existing sessions first, when the task justifies them.
- Operator-saved template (`edited`/`custom`): unchanged — the saved roster
  is written as a team plan and opened exactly as before, idempotently, so
  a crash mid-creation never duplicates a worker.
- No template: unchanged (Orchestrator only).

Registry and team APIs are unchanged in shape: `templates()`, `saveTemplate`,
`removeTemplate`, `team_forge` (its list now prints each template's
recommended roles and states the model), the protocol endpoints (descriptions
updated), and the generated client (regenerated for the optional field).

## The playbooks

Every kept built-in playbook was rewritten around the same dynamic rules,
with its domain expertise kept:

- Understand the goal and inspect the existing project first.
- Select the appropriate categories of work; create as many stages as the
  task actually needs; dependencies come from real technical requirements.
- Determine the smallest sufficient set of roles; work solo when that is
  enough; parallelize only independent work; reuse sessions before creating.
- Add stages or roles when discoveries justify them; replan when
  assumptions change; require evidence before marking work complete.

Domain guidance survives the rewrite: mobile still covers lifecycle,
offline behaviour, permissions, emulators, platform compatibility and
signing; deep-audit still covers multi-source CVE cross-referencing and
reachability; system still maps the monorepo's layers and dependency
direction. What is gone is every fixed count: no "Phase 1–5", no "5-stage
DoD", no mandatory second developer, no full-factory deployment. A test
(`orchestra-role-quality` + schema `orchestra.test`) scans every built-in
playbook for fixed stage counts and mandatory-roster phrasing, and verifies
every recommended role resolves to a registered role.

## The Orchestrator prompt

`PROMPT_ORCHESTRATOR`'s "Software Factory Protocol" block (factory by
default, fixed 5-stage DoD) was replaced with an "Autonomous Dynamic
Workflow" block: dynamic team sizing, research-first, binary-analysis,
dynamic DoD with the same critical verification invariant (real commands,
never file-existence checks), autonomous MCP acquisition, and explicit
per-session MCP assignment. The anti-simulation and anti-fraudulent-test
rules are unchanged.
