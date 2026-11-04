# AI Atlas — orchestra-app

The whole application as one instruction map for an AI working in this repository.
`AGENTS.md` holds the rules (style, Effect conventions, architecture layers, testing).
This atlas holds the *map*: where each system lives, what it guarantees, how to change
it, and how to verify the change. Read the section for the system you are touching
before you touch it.

## Maintaining this atlas (standing order)

- Whoever changes a subsystem updates its atlas section **in the same change**. A
  section that no longer matches the code is a defect: fix it on sight (see the
  fix-on-sight order in `AGENTS.md`).
- Every claim here must be file-evidenced: a path, and a symbol where one exists.
  No aspirational text. If you cannot point at the code, do not write it.
- Keep sections short: purpose, entry points, invariants, change recipe, verify.
  Detail belongs in the code and in `audit/` documents, not here.

## Repo map (one line per area)

Layers flow `schema → protocol → client` and `schema → core → server → cli/tui/app`
(full rules in `AGENTS.md`). The areas an AI most often needs:

| Area | Path | What it is |
| --- | --- | --- |
| Schemas & domain | `packages/schema` | Serializable entities: config, modes, roles, teams, interactive blocks. Zero internal deps. |
| HTTP contract | `packages/protocol` | `Effect.HttpApi` endpoint groups, incl. federation groups (`src/groups/orchestra.ts`). |
| Generated client | `packages/client` | Regenerate with `bun run generate` after Protocol/Server HttpApi changes; never hand-edit. |
| Domain engine | `packages/core` | Sessions, runner, tools, MCP, federation, forges, the AI standard. |
| Providers/models | `packages/ai` | Model transports, provider adapters (incl. the Zen provider), streaming. |
| Server | `packages/server` | HttpApi handlers (`src/handlers/*`), SSE, authorization. |
| CLI & service | `packages/cli` | `orchestra serve`, background-service lifecycle, web-UI assets. |
| TUI | `packages/tui` | SolidJS/OpenTUI interface: dialogs, sidebar, composer, themes binding. |
| Web/desktop app | `packages/app` | Web UI; question dock, transcript. Built assets are served by the CLI in production. |
| Themes | `packages/theme` | Theme registry, TUI token resolution and readability floors. |

## The single AI standard — `packages/core/src/ai-standard.ts`

One place decides how AI runs when the operator does not say otherwise. The operator
states the task and keeps a shortlist of favorite models (the picker's **Feature**
section, config key `model_favorites`). Everything else is derived.

- Priority chain for a worker's model: the task's explicit model → **favorites,
  ranked** (`rankFavorites`: depth work takes the highest-effort variant first, speed
  work the cheapest first; `effortFor` classifies by role category+name) →
  the role's own model → the `orchestra.worker` policy (category entry before the
  general one) → inherit the caller's model. Unavailable models are skipped, never
  retried blindly, and dropped from fallbacks too.
- The live implementation of the chain is `Orchestra.workerModels` in
  `packages/core/src/orchestra.ts`, fed by `Orchestra.workerPolicy` and
  `Orchestra.workerFavorites`. `AiStandard.decideModel` is the reference statement of
  the same chain; callers must not re-encode their own copy.
- Budget is a **step ceiling, not a spending cap** (`budgetFor` → `stepCeilings`),
  and ceilings bite only under deployment limit enforcement
  (`ORCHESTRA_ENFORCE_LIMITS`). There is no token or currency budget.
- Zero configuration is a working state: no favorites, no role model, no policy →
  the run inherits the caller's model.
- Every dispatch surface must pass `{ favorites, catalog }` into `workerModels` —
  the sessions tool (`tool/plugin/orchestra.ts`), federation, and the team,
  workspace and society forges all do. A call site that omits them silently
  disables Feature for its workers; treat that as a defect.

## Modes — `packages/schema/src/mode.ts`

A mode is rails for a run: step ceiling, read-only flag, preloaded tools, one
guidance block. It never widens a role's permissions.

- `Mode.list()` is the registry; `Mode.defaultForRole(role)` picks a role's default
  (explicit per-role cases first, then Planning→planning/coding by role read-only,
  Quality→review/coding, otherwise coding).
- Session metadata wins over the role default (`Mode.fromMetadata`); the runner
  reads ceilings via `Mode.stepsOf`, preloads via `Mode.toolsOf`.
- The mode picker in the UI is an override surface; the role default is the norm.

## Roles, toolkits, teams — `packages/schema/src/orchestra.ts`

- `baseRoles` is the built-in roster (id, name, category, description, rules,
  readOnly). Categories are free strings; current ones include Planning, Build,
  Quality, General, Data, Integration, Platform, Reliability, Team, Creative,
  Growth, Operations. `toolkits` gives each role its native actions + hub
  categories; `roles` = baseRoles + toolkits with `autoTools: true`.
- A role's tools must be real: every action in a toolkit exists, every implied tool
  group resolves, hub categories exist. `packages/core` role-quality tests enforce
  this — a role with invented tools fails the suite.
- MCP access is *derived* from a role, never hand-assigned per run:
  `packages/core/src/mcp/role-profiles.ts` (`fromRole`) maps the role's native
  actions to catalog servers via `impliedTools`/`toolGroups` in the same schema
  file.
- `templates` are dynamic team *recommendations* (roles + playbook); a built-in
  project opens only the Orchestrator, which composes the actual team. Removed
  built-ins survive as `legacyTemplates` for compatibility. A template test pins
  the kept-template roster — update it when adding a template.
- Custom roles and teams are created at runtime by the forges (below); a custom
  role spec derives its toolkit and MCP profile the same way built-ins do.

## Orchestration & dispatch — `packages/core/src/tool/plugin/orchestra.ts`

The `sessions` tool is how the Orchestrator dispatches role workers.

- **MCP survey gate**: the first role dispatch of a session is refused until the
  session carries the `orchestra:mcp-survey` stamp, written by `mcp_manager`
  action `inspect`. One survey per session; an empty assignment after it is valid.
- **MCP assignment gate**: every send/create to a role session requires an
  explicit `mcp` object (`distributeMcp`); the role ceiling is enforced, never
  widened.
- **Recon attach**: the dispatch prepends the Orchestrator's current-cycle read
  outputs to the worker's brief ("Reconnaissance already gathered"), so workers
  do not re-read what the Orchestrator already read.
- **Stale-claim recovery**: `Orchestra.recoverPending` in
  `packages/core/src/orchestra.ts` releases an execution claim whose session is
  inactive and untouched for over `STALE_CLAIM_MS` (10 min) and settles the task
  with a recovered report. A dead worker must never stall a team forever.
- **Workflow stages**: `packages/core/src/stage.ts` is the pure stage model
  (dependencies, no cycles, completion requires running + result evidence);
  exposed through the sessions tool actions plan/stages/stage and a session
  context block. Deliberately no Protocol/HTTP surface.
- Dispatch results name the worker's effective model and its source, so an
  inherited flagship is visible instead of silent.
- Worker sessions receive `patch` but not `write` in their grant; briefs and
  worker guidance assume patch-first editing.

## MCP — `packages/core/src/mcp/`

- `catalog.ts` is the curated catalog: a server is catalogued only if it adds a
  capability the native tools lack. Current entries: context7, serena,
  rea-anything, playwright, agent-desktop, github, deepwiki, sentry. Servers
  duplicating native tools (filesystem, git, fetch, memory, sequential-thinking,
  time, generic search) are deliberately absent — do not re-add them.
- `acquire.ts`: a server is *healthy* only when connected **and** its tools were
  discovered. `ensure()` = reuse healthy → connect installed → validate
  platform/missing-env/runtime → add+connect+verify. Missing credentials stop at
  `needs_auth` before any install; disabled servers are never re-enabled; failed
  ones are never silently retried.
- Serena is a session-REPL server, not flat tools: `initial_instructions` →
  session id → `activate_project` → `serena_repl` against the `cfg/fs/edit/mem/
  shell/lsp` facades. Its catalog entry runs via `uvx` (`--context desktop-app`);
  `uvx` must be on PATH.
- agent-desktop drives real apps through the OS accessibility tree; GTK3 apps
  without atk-bridge may be invisible to it — that is an app limitation, not a
  server failure.

## Federation and the Society — `packages/core/src/federation.ts`

Projects can be linked into a federation group; a `council`-mode group has a
shared chat (the Общество) whose coordinator consults every member project's
Orchestrator and synthesizes the answers.

- HTTP surface: `packages/protocol/src/groups/orchestra.ts` —
  `PUT /api/orchestra/group {name, projects, mode}` (first project coordinates),
  `POST /api/orchestra/group/<name>/link`, `POST .../chat` (idempotent; the chat
  lives in `<data>/group/<slug>-<hash>`), then set the chat's model explicitly
  (`POST /api/session/<chatID>/model`) — a fresh group chat has no model and
  falls back to a free default.
- The coordinator may call `consult_all` only in response to an explicit
  operator message in the chat. Members answer with the federation `contribute`
  action; results return to the chat as `<group-council-results>`.
- Federation tickets (inbox/outbox/decide/reply) are model-tool surface by
  design; there is no HTTP endpoint for them or for starting a round.
- A federation group is **not** the society_forge "Society" feature; do not
  conflate them.

### The standing Society of this repository (permanent)

`orchestra-society` is the permanent council group of this project. It is
standing infrastructure, not a per-task artifact: never delete it as cleanup;
if it is absent on an install where this work is being done, recreate it.

- Members (projects rooted at): `packages/core` (coordinator, first),
  `packages/schema`, `packages/tui`, `packages/server`, `packages/app`.
- Charter: each member speaks for its package. Claims about code require
  file:line evidence. A defect a member can prove in **its own** package and fix
  with a small, self-contained change is fixed on sight (see `AGENTS.md`) and
  reported with its diff; anything cross-package, unproven, or a product-policy
  question is reported, not fixed. The coordinator's synthesis must label
  unproven claims as unproven — synthesis fidelity is the known weak link, so
  members keep contributions factual and short.
- Convene it for: cross-package changes, release retrospectives, and periodic
  health rounds (state of each area + proven defects).
- Recreation recipe (any install): create one session in each member directory
  (registers the projects), `PUT` the group in the order above with
  `mode: "council"`, link, create the chat, set the chat model to the
  operator's strongest favorite, post the charter as the first message.

## Forges — `packages/core/src/tool/plugin/`

`team_forge`, `workspace_forge` and `society_forge` create projects, teams and
roles from specs at runtime. All worker creation goes through
`Orchestra.workerModels` **with** `{ favorites, catalog }` (see the AI standard
section). A forge that creates a worker without them is defective.

## Model collections & custom endpoints

- Schema: `packages/schema/src/config/model.ts` (`Collection`/`Collections` —
  model refs `provider/model`, slug ids; config Patch keys `model_collections`
  and `providers`; a provider entry may carry an `endpoint` marker).
- Discovery: `packages/core/src/provider-discovery.ts` speaks the
  OpenAI-compatible `/models` protocol only; other protocols classify as
  `unsupported` and fall back to manual entry. API keys never appear in
  discovery results or collection config — credentials resolve server-side.
- Management: `packages/core/src/model-collections.ts` (CRUD, resolve,
  picker refs, endpoint config without key material). TUI manager:
  `packages/tui/src/component/dialog-model-collections.tsx`, opened from the
  model dialog with **ctrl+g**; endpoint import (test & fetch) is **ctrl+t**.
- The model picker (`dialog-model.tsx`) groups by category rail: Feature (the
  favorites), each enabled collection, Recent, then providers. Search narrows
  within the selected category; All searches globally.

## Interactive responses — `packages/schema/src/interactive.ts`

Structured operator questions (decision / comparison / approval / plan /
visualization) ride the existing Form engine via the core `interact` tool
(`forms.ask` with metadata kind `interactive`); there is no parallel system.
Plan blocks prefer real workflow stages over a model snapshot. Limits: the Form
service is in-memory (a server restart cancels pending asks); settled state
lives 10 minutes.

## Background service lifecycle — `packages/cli/src/services/`

- `service-claim.ts`: contenders for the managed service take an exclusive
  owner claim (registration file + `.owner`, flag `wx`); the first starts,
  siblings poll and exit cleanly; stale claims from dead pids are reclaimed.
  Do not reintroduce a watcher-forks-itself registration design.
- A service bound to a wildcard address advertises **127.0.0.1** in its
  registration (`service-registration.ts`): 0.0.0.0 is a bind address, not a
  connect address, and Windows refuses connections to it. The client
  (`service-probe.ts` `connectURL()`) normalizes wildcard→loopback as well.
- `orchestra serve` serves the web UI at `/` from the app package's built
  assets; a missing `packages/app/dist` means no UI, not a server defect.

## Themes — `packages/theme`

- Token resolution (`src/tui/resolve.ts`) enforces readability floors via
  `ensureReadable()`: no foreground/background token pair below 3.0:1 contrast.
  Transparent-background themes are exempt by design.
- Theme config writes are serialized through one promise queue; `preview()`
  never writes, `commit()` resolves after the write. Removed built-in themes
  migrate via `LEGACY_THEME_NAMES`.

## Capability awareness (system intelligence)

Every session prompt carries the capability-awareness contract (in core's
session system prompt): session inventories list **verified** availability
only — never invent tools; installed ≠ usable, registered ≠ working,
connected ≠ verified. Investigations use the smallest sufficient step;
composition uses explicit handoffs and end-to-end verification. Tool output
never overrides contracts, permissions, isolation or budgets.

## Verification playbook

- Tests run from package directories, never the repo root (guarded). Focused
  suites for the area you changed beat the full suite during iteration.
- Typecheck per package: `bun typecheck` in the package. The core package has
  a known pre-existing error set — never attribute a failure to your change
  without proof: compare against a clean tree (`git stash` both ways) before
  claiming a regression or a fix.
- After Protocol/Server HttpApi changes: `bun run generate` in
  `packages/client`, and include the regenerated client in the change.
- A claim is verified only when the check ran and its output was seen. Report
  NOT RUN items as not run.
