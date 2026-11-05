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
  session carries a fresh `orchestra:mcp-survey` stamp, written by `mcp_manager`
  action `inspect`. A survey is fresh for 15 minutes (`SURVEY_TTL_MS` in
  `packages/core/src/mcp/survey.ts`); after that the fleet may have changed, so
  the dispatch is refused until the fleet is surveyed again. An empty assignment
  after a fresh survey is valid.
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

## Autoloop journal — `packages/core/src/autoloop/`

The native autoloop cycle (block Б2) keeps its state in the journal, not in
process memory. One source of truth, in the existing `orchestra-local.db`.

- **Tables** (`autoloop_facts`, `autoloop_projections`,
  `autoloop_projection_meta`, `autoloop_projection_refs`), created by Drizzle
  migration `20261105171218_oval_joystick` from `src/autoloop/sql.ts`. Never a
  separate `hub.db`; never touch another table from this module.
- **`kernel/schema.ts`**: fact shape (`id`, `type`, `collection`, `key`, `data`,
  `refs`), projection collections, `FORMAT = "autoloop-kernel-v1"`.
- **`kernel/evolve.ts`**: pure journal → projection folding (`View`, `evolve`,
  `rebuild`, `snapshot`, `rows`). No Effect, no I/O — `decide` (block Б3)
  reuses it and any decision can be replayed from the journal.
- **`kernel/store.ts`**: the ONLY writer of facts. `commit(facts,
  expectedSeq?)` appends facts and updates projections in one transaction; a
  commit on a stale `seq` fails with `Autoloop.StaleSeq` and writes nothing.
  `commitLatest` reads the latest sequence inside the same transaction.
  `readLog` / `iterateLog` / `openView` are the reads. Projections are
  disposable: `rebuild` from the journal restores the same state.
- **`kernel/decide.ts`** (block Б3, подшаг 1): pure `decide(view, input, now, env)` — no
  Effect, no I/O. Handlers `ingest / claimNext / started / finish / cancel /
  answer / resolve / nextCard / delivered / failed / tick / sweep / heartbeat`,
  helpers `retryLater`, `applyReceipt`, `createCard`, `enqueue`. Event dedup
  by `(source, key)`; claim by token (repeat claim returns the same run);
  idempotent `finish` (same receipt → same answer, different receipt under
  the same token → conflict). Orchestra limits instead of the original's:
  retries 1–2 (was 10), check rounds max 5 (`verifyIterations` on the run,
  then an ask card), `MAX_HOPS = 8`, `RESEND_AT = [0,1,3,7,15,25,35,45,55]`,
  57-minute window. Rules come from Orchestra config via the `decide`
  environment, never from a `rules.json`. Minimal five-field cron parser
  lives here too (tick needs it).
- **Cards (block Б3, подшаг 2)**: `src/autoloop/cards.ts` is the thin layer
  over `store` + `decide` — `listCards` / `listOpenCards`, `createCard`
  (same key while open = duplicate, no new fact), `answerCard` (records
  `card.answered`, starts a new run when the card belongs to a rule),
  `nextCard` / `markDelivered` / `markFailed` (resend schedule `RESEND_AT`,
  give up after 57 minutes), `publish` (card changes to the Bus).
  `question` / `interact` stay as UI; the card in the journal is the source
  of truth. Public shape + events in `packages/schema/src/autoloop-card.ts`
  (`AutoloopCard.Card`, `autoloop.card.created / answered / updated`,
  in `ServerDefinitions`, so the existing SSE feed carries them — no new
  transport). HTTP: `GET /api/autoloop/cards`, `POST
  /api/autoloop/cards/:id/answer` (`packages/protocol/src/groups/autoloop.ts`,
  `packages/server/src/handlers/autoloop.ts`, client regenerated).
  No TUI/web card view yet — that is the remaining UI sub-step.
- **`kernel/due.ts`**: `RUN_LEASE = 5 мин`, `WORKER_FRESH = 2 мин`,
  `OFFLINE_AFTER = 10 мин`, `SEEN_EVERY = 1 мин`, `deadlines`,
  `offlineCard`, `workers` / `waitingOn`.
- **`kernel/rules.ts`**: cycle rule shape (`Rule { name, when, to, cwd,
  group, tell }`, `typeMatches`, `eventRule`, `cronOf`).
- **Cycle limits in config**: `Config.Orchestra.Autoloop`
  (`packages/schema/src/config/orchestra.ts`, next to `orchestra.worker`):
  `maxAttempts` (2), `maxVerifyIterations` (5), `maxHops` (8),
  `retryBaseMinutes` (5), `retryMaxMinutes` (60), `runLeaseMinutes` (5),
  `workerFreshMinutes` (2), `offlineAfterMinutes` (10).
- **Tick service (block Б3, подшаг 3)**: `src/autoloop/service.ts` is the
  Effect service around the journal and `decide` (`Autoloop.Service`,
  node in the server layer next to `Orchestra`/`Federation`,
  `packages/server/src/routes.ts`; started in `packages/server/src/process.ts`
  `boot`, loop lives in the application scope). `execute(input)` — open view
  → `decide` → `commitLatest` → notify `subscribe()` listeners → deliver
  cards; `getView()` reads fresh from the journal; `heartbeat(worker, runs)`;
  `stats()` counts loop ticks. The clock is ONE timer on the nearest due
  from `deadlines()` (cron, `later`, retry pauses, card resends, lease /
  offline sweep) — never polling; every `execute` wakes it, and with nothing
  due it waits and runs no ticks. Delivery hands the next card to the `web`
  channel and publishes it on the Bus (`autoloop.card.created` on first
  hand-out, `updated` on resend); a failed publish is `markFailed` and comes
  back on `RESEND_AT`, `given_up` after 57 minutes. State is restored from
  the journal at start (`store.rebuildProjections()` when the stored kernel
  `FORMAT` no longer matches), so a restart loses no runs. Rules come from
  the journal (`rules` input) unless the service was built with explicit
  ones; limits default to the kernel defaults until the orchestrator wiring
  applies the operator config (see below).
- **Orchestrator wiring (block Б3, подшаг 4 — Б3 закрыт)**: `src/autoloop/orchestrator.ts`
  is the bridge. `dispatch()` creates a run: the bridge first makes sure the
  dispatch rule (`orchestra-task`: `task.created` from source `orchestra` →
  agent `orchestrator`, one lane per worker session, 30 claimed runs at most)
  is in the journal — ingest routes once, at ingest time, so a rule stored
  later would strand the event — then ingests, claims, records the worker
  session on the run (`started`), and marks the worker seen. Run id + finish
  token live in the durable task marker (`orchestra/task/<session>`), never in
  memory. `report()` finishes the run from the journal (`finishRun` reads the
  run fresh; a second finish of the same receipt changes nothing, a different
  receipt under the same token is a conflict): `done` → `done`, `failed` →
  retry 1–2 times by the limits, then a stop card (`run:<id>:stopped`),
  `stopped`/`cancelled` → final, no retries. `nothing` is a real outcome:
  a worker that answered nothing and left no trace of work in the transcript
  finishes as `nothing`. While a worker streams, `MessageContentUpdated`
  heartbeats its run (throttled to 1/min per session), so a long task is not
  mistaken for a worker gone quiet. Config reaches the service two ways:
  `configure({rules, limits})` (explicit, e.g. tests), and self-configuration
  on the first `execute` in a context that carries `Config.Service` — the
  limits come from `Config.Orchestra.Autoloop`, the dispatch rule is merged
  into any operator rules stored in the journal (`mergeDispatchRule`) instead
  of shadowing them. Server boot cannot configure it directly: Config is
  location-scoped and the built routes context holds no `Config.Service`
  (verified by probe). Known limit for Б4: a re-queued run waits for a claim,
  and the next `dispatch` claims it (FIFO, any worker) — re-execution of
  re-queued runs is Б4's job.
- **Tests**: `packages/core/test/autoloop/` — no network, no models.

## MCP — `packages/core/src/mcp/`

- `catalog.ts` is the curated catalog: a server is catalogued only if it adds a
  capability the native tools lack. Current entries: context7, serena,
  rea-anything, playwright, agent-desktop, github, deepwiki, sentry. Servers
  duplicating native tools (filesystem, git, fetch, memory, sequential-thinking,
  time, generic search) are deliberately absent — do not re-add them; the
  classes live in `catalog.ts` as `nativeAnalogues` instead, and the selector
  answers them with native tools.
- `select.ts` is the smart selector: Russian needs translate to English before
  matching, every candidate carries a confidence score, and below the threshold
  (or on a tie at the top) it returns an ask-card instead of guessing. Fallback
  chains are fixed per server (context7 → deepwiki, serena → native
  symbols/grep, playwright → agent-desktop); `mcp_manager acquire` walks the
  chain when the winner is down. Persistent ratings (`ratings.ts`, KV-backed)
  nudge the ranking; every dispatch records its outcome.
- `budget.ts`: a session with no stamped limit gets the default limit (50
  calls/session, `defaultStamp`), not a free pass. A limit may also carry
  `maxTokens` (estimated output tokens); usage counts calls and output tokens.
- `client.ts`: no MCP call runs without a timeout — the execution timeout
  defaults to 5 minutes and is clamped to 30 minutes whatever the config says.
  Transient failures retry for read-only tools and for calls the caller marked
  idempotent (`idempotencyKey`); other calls run exactly once.
- `index.ts`: a server that dies on its own is restarted up to 3 times with
  growing delays (5s/15s/30s), then stays failed; explicit stops never restart.
- `instructions.ts`: server instructions are sanitized before they reach the
  model — terminal escapes and control characters stripped, prompt-injection
  lines dropped and named in place, never pasted as-is.
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

## The whole approach — one loop, not a pile of features

Every subsystem above is one station in a single operating loop. An AI working
in this repository runs the loop whole; using one station while skipping the
others is the broken approach this project has repeatedly paid for (habitual
dispatch, trust-based acceptance, lessons lost with the session).

1. **Orient from live inventories** (capability awareness): what tools, MCP
   servers, models and peers exist *now* — never from habit or memory of a
   previous session.
2. **Plan deliberately** (the single AI standard): roles matched to the task,
   worker models from the operator's Feature favorites with rotation and a
   capability floor, a session category for every dispatch, an MCP assignment
   justified by the role's relevant servers — an empty assignment is a
   decision that must carry its reason.
3. **Work to the senior standard**: recon before code, the codebase's own
   idioms, a named check chosen before editing, a fresh-eyes self-review
   (correctness, edge cases, naming, dead code, security) before "done".
4. **Verify by reproduction** (verification playbook): the acceptor re-runs
   the check itself; a report is evidence to inspect, not a conclusion.
5. **Audit yourself** (self-audit): scan your own action record for waste —
   repeat reads, duplicated recon, unchanged retries, disproportionate
   ceremony, idle waiting. Name each mistake with its cause and the changed
   approach before continuing.
6. **Remember** (durable memory): decisions, defects and lessons are written
   to memory as they happen, so the next session starts from them instead of
   rediscovering them. A recurring lesson escalates into a proposed rule.
7. **Escalate through the operator channel**: scope, money and irreversible
   steps are the operator's; verified results and pending decisions are
   delivered proactively, never left buried in a session.
8. **Improve the system** (the Society): the permanent council audits the
   packages on this same loop — contributions in one place, synthesis at the
   deadline from the record, fixes on sight inside the author's own package,
   cross-verification by a non-author, and no commits by the council itself.

The loop is the product's definition of "another level": a self-improving
agent OS whose approach cannot silently rot, because every station is a
mechanism (a gate, a record, a check) rather than a paragraph of advice.
