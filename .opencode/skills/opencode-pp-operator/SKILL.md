---
name: opencode-pp-operator
description: Use when the user wants the agent to work end-to-end on opencode-pp from request to verification. Provides capability map, recipes, safety/confirmation rules, registry extension guidance, diagnostics, and 5 end-to-end scenarios.
---

# opencode-pp-operator

This skill makes the agent operate end-to-end on this repository: understand the request, map to capabilities, assemble a team plan, dispatch tasks, run checks, verify, and report. It references `ARCHITECTURE.md` rather than duplicating its contents.

## When To Use

- Use when the user says "do it from start to finish", "implement end-to-end", or gives a task that needs coordination across packages.
- Use when working with LAN rooms, teams/roles, federation, DoD, notes, or extending registries.
- Do not use for trivial single-file edits if the user just wants a quick fix; follow the minimal-change rule from AGENTS.md.

## Capability Map

- **Understand**: Read `AGENTS.md`, `ARCHITECTURE.md`, `.opencode/notes/project-map.md`, `.opencode/notes/backlog.md` as needed.
- **Plan**: Break into 3-10 steps; each step becomes one commit. List affected files first.
- **Coordinate**: Work with project teams/roles via orchestration patterns; keep tasks independent where possible.
- **Extend**: Manage roles/tools/commands/blocks/themes via their registries without duplicating logic.
- **Verify**: Run `bun run check` after each step; run relevant package tests; describe manual TUI checks when UI changes.
- **Report**: Follow the required report format (done/changes/checks/assumptions/backlog/risks).

## Recipes

### Recipe 1: Project → Team → Tasks → Run → Check
1. **Project**: Identify packages affected via search (grep/glob). Read only the necessary files.
2. **Team**: Pick minimal roles for the task (e.g., core/tui/server/schema as needed). Avoid spawning unnecessary sessions.
3. **Tasks**: Write acceptance criteria per step; make steps atomic with disjoint scopes when parallelizable.
4. **Run**: Implement step by step; reuse existing components/helpers; respect tokens/i18n/theme.
5. **Check**: After each step, `bun run check` + relevant tests. For UI, list manual steps + expected results.

### Recipe 2: Diagnose Connection/Integration Issues
1. Read relevant modules and their index.ts exports.
2. Trace imports: verify dependency direction (schema→core/protocol; client never imports core/server directly).
3. Check protocol/httpapi sync; if HttpApi changed, regenerate client (`bun run generate` in packages/client) per AGENTS.md.
4. Validate Effect layers/wiring (instance graphs) and event bus usage.
5. Run focused typecheck/tests; record findings in backlog if pre-existing.

### Recipe 3: Extend via Registries
1. **Roles**: Update team/orchestra role definitions; ensure agents get correct prompts/permissions; register in agent/team plugins as appropriate.
2. **Tools**: Add tool plugin under `packages/core/src/tool/plugin/`; register in tool runtime/registry; update permissions.
3. **Commands**: Add CLI command under `packages/cli/src/commands/`; follow lazy loading pattern; wire into command registry.
4. **Blocks**: Add TUI blocks/components under `packages/tui/src/`; reuse tokens/theme; respect terminal constraints (width/height/colors).
5. **Themes**: Extend theme schema/defaults/resolution/types; verify light/dark and custom-theme fallback paths.

## Safety & Confirmation Rules
- **No big-bang**: One module/change area per series; verify after each step.
- **No destructive ops**: Never run git push/reset/deploy unless explicitly requested. No --force, no history rewrite.
- **Preserve data/config**: Do not delete user configs/data; migrations must be reversible.
- **Secrets**: Never log secrets/tokens; redact in outputs.
- **Respect tool refusals**: If a tool refuses, stop and report (no bypass).
- **Ask only when necessary**: Use ask_user only for non-obvious decisions that could lose data; otherwise pick a sensible default and record assumption.
- **No masking**: Do not skip tests, weaken assertions, swallow errors, or add suppressions to pass checks. Record pre-existing failures in backlog.

## Diagnostics
- **Type issues**: Run `bun typecheck` in affected package(s); read first error context fully.
- **Test failures**: Run focused tests with pattern; inspect actual failure (not filtered). Preserve exit status if piping.
- **Import cycles**: Check dependency direction against `ARCHITECTURE.md` layers; prefer re-export via package index.ts.
- **Connection gaps**: Compare protocol contract vs server handlers vs client; check tool registration and agent permissions.
- **Unused by agents**: Look for tools/agents registered but not referenced in prompts/permissions or vice versa.

## 5 End-to-End Scenarios

1. **E2E-1: Federation → President Flow** - Create a lead group, spawn President chat, report to President via federation, verify synthetic delivery and restrictions. Verify with federation tests + dialog-groups TUI test.
2. **E2E-2: Council Consultation** - Council group consult_all → contributions → synthesis. Verify validation (only after explicit operator task), completion flow, and error cases.
3. **E2E-3: Team Role Extension** - Add a custom role via team-forge patterns or directly; update prompts; ensure orchestrator context includes relevant info; verify role registration and permissions.
4. **E2E-4: Tool Registration** - Add a new tool plugin, wire into runtime, set permissions, test via agent calling it; verify schema validation and error handling.
5. **E2E-5: TUI Group Dialog** - Modify dialog-groups UI respecting i18n/theme/terminal constraints; verify with tests; describe manual checks for narrow/wide terminals and light/dark themes.

## References
- `ARCHITECTURE.md` - Layer map, dependency rules, package layout, runtime paths.
- `AGENTS.md` - Coding/testing/check rules, branch/commit conventions, style.
- `.opencode/notes/backlog.md` - Pre-existing issues to record, not mask.
- `.opencode/notes/project-map.md` - Project structure map if present.
