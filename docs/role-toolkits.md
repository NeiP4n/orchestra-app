# Role toolkits — роль → инструменты

Every role gets the tools its own work needs, and nothing else. The map lives
in two places that must agree:

- **Built-in roles**: their tool lists are in `packages/schema/src/orchestra.ts`
  (`toolkits` map; `roles` = baseRoles + toolkits). That is the single source
  of truth for built-ins.
- **Every other role** (operator-created, or invented by a planner on a live
  run — Probe Runner in Б14): `packages/core/src/roles/toolkits.ts`
  (`RoleToolkits`) classifies it into one of the seven kinds below and hands
  it the toolkit of that kind's anchor role. A role with no list used to run
  unrestricted; now it never does.

Enforcement (not decoration):

- `packages/core/src/plugin/team.ts` pushes `Orchestra.toolRules(...)` for
  every role — explicit list or kind toolkit — and logs a warning for roles
  running on the kind default.
- The `sessions` tool (`packages/core/src/tool/plugin/orchestra.ts`, `choose`)
  refuses per-task tools outside the role's effective toolkit, and logs a
  warning when `tools: ["all"]` lifts the ceiling for one task.
- `packages/core/src/mcp/role-profiles.ts` (`fromRole`) derives MCP access
  from the same effective tools, so a custom role's MCP ceiling is its kind's.

The operator can widen any role in the team editor; the default only stops a
role from silently running with every tool at once.

## The seven kinds

Tool groups (from `toolGroups` in the schema): READ = read, glob, grep,
symbols, file-diff; EDIT = edit, patch, write; SHELL = shell, hub;
PROBE = shell, hub (read-only evidence gathering); WEB = webfetch, websearch,
research; SCREEN = browser, desktop, playtest; SKILLS = skill, skill_catalog;
NOTES = note, idea_bank, plots; REVERSE = rea-anything_\*, rea_\*;
VCS = github_\*; FORGE = mcp_forge, command_forge, plugin_forge;
MCP = mcp_\*, context7_\*, deepwiki_\*, serena_\*; SENTRY = sentry_\*.

| Kind (anchor role) | Tools | Typical failure each tool closes |
|---|---|---|
| **Orchestrator / planner** (`strategic-planner`) | READ, PROBE, WEB, SKILLS, NOTES, VCS, REVERSE, FORGE, MCP | Assigns a dead provider's model to workers → health-checked assignment and cross-provider fallback (see below); edits files itself instead of delegating → no EDIT; loses workers across projects → society-wide status; re-reads the brief every turn → context governor + compaction |
| **Scout / researcher** (`researcher`) | READ, PROBE, WEB, browser, SKILLS, NOTES, VCS, REVERSE, FORGE, MCP | Guesses from memory instead of fetching → webfetch + context7/deepwiki; reports without evidence → read + shell evidence gathering; never reaches an interactive source → browser |
| **Architect** (`architect`) | READ, PROBE, WEB, VCS, REVERSE, SKILLS, NOTES, FORGE, MCP | Designs without reading the code → read + serena symbol search; writes product code instead of contracts → no EDIT, no SHELL builds; decides without checking constraints → REVERSE + VCS |
| **Coder** (`developer`) | READ, EDIT, SHELL, WEB, SCREEN, SKILLS, NOTES, VCS, REVERSE, FORGE, MCP | Edits blind → read + symbols first; ships untested code → shell + playtest to run checks; reimplements a library → context7/web; loses the contract → file-diff + github |
| **Tester / probe** (`tester`) | READ, EDIT, SHELL, WEB, SCREEN, SKILLS, NOTES, VCS, REVERSE, FORGE, MCP | Probes without a failure reason → shell + playtest + browser drive the app and the report names the reproduction; runs on a dead model → cross-provider fallback; "fixes" product code instead of reporting → the society brief + `readOnly` say report, the toolkit's EDIT is for test scaffolding only |
| **Reviewer** (`reviewer`) | READ, PROBE, WEB, browser, SKILLS, NOTES, VCS, REVERSE, FORGE, MCP | Reviews without reading the diff → file-diff + github; approves without evidence → PROBE (run the checks, don't trust the diff); rubber-stamps → no EDIT, so a finding must go back as a report |
| **Releaser** (`devops`) | READ, EDIT, SHELL, WEB, browser, VCS, SKILLS, NOTES, SENTRY | Releases without checking production → sentry_*; releases without running the build → shell + hub; ships what testers never saw → github_* for the diff and checks |

## The live-run mechanisms behind the map

The map alone does not fix the Б14 failures; the mechanisms it points at do
(each lives where the code already owns the decision):

- **(a) Model assignment only from live providers** — `fallbackModel` in
  `packages/core/src/session/runner/llm.ts` no longer refuses to switch after
  the retry budget is spent, and the fallback chain crosses providers for
  worker sessions too; `mainSessionFallbackChain` treats a 502/503/504 like
  an authentication failure (the whole provider is down, not one model).
- **(b) Session creation suggests the reasoning variant** — the `sessions`
  tool's `resolveVariant` fills in the catalog default (`#medium` first)
  instead of refusing a bare `provider/model`.
- **(c) Society-wide status** — `group_status` in the federation tool reports
  live sessions per project and for the whole Society (counts only; session
  IDs stay private by design).
- **(d) Context compaction for roles** — the context governor
  (`packages/core/src/session/context-governor.ts`) elides old bulky tool
  output and old assistant tool-call arguments past the soft limit. Measured
  on a planner-like transcript of 8 dispatches with 4k briefs: raw 18_647
  estimated tokens, results-only governor 11_824, calls+results 6_033
  (−68% vs raw, −49% vs the old governor).
- **(e) Stale session outcome** — the projector clears `idle_outcome` when a
  drain starts, so a resumed session no longer reads "failed" from its last run.
- **(f) Favorites reflect health** — `AiStandard.decideModel`/`rankFavorites`
  take the providers currently cooling down and skip them, so a dead
  provider's favorite is passed over and live ones come first.
