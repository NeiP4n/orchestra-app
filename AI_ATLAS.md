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
  enforced by default (`Limits`; opt out only with `ORCHESTRA_DISABLE_LIMITS`).
  A drain additionally stops on its wall-clock/token budget (`Limits`:
  4 h / 10M estimated prompt tokens by default). There is no token or currency
  budget in the model-selection chain. (The `budget` tool, `tool/plugin/budget.ts`, is
  separate: it stores a per-session token limit and its forecast refuses work
  once the limit is spent.)
- Zero configuration is a working state: no favorites, no role model, no policy →
  the run inherits the caller's model.
- Every dispatch surface must pass `{ favorites, catalog }` into `workerModels` —
  the sessions tool (`tool/plugin/orchestra.ts`), federation, and the team,
  workspace and society forges all do. A call site that omits them silently
  disables Feature for its workers; treat that as a defect.

## Main-session model fallback — `packages/core/src/session/runner/llm.ts`, `error-taxonomy.ts` (G2-14)

A worker that is refused outright continues on the next model the operator gave
it. The project's main session carries no operator-given list, so it falls back
on the live catalog instead (`mainSessionFallbackChain`): other models of the
same provider first — except on an authentication failure, where the whole
provider is dead and the chain starts on another provider — then the verified
Anymodel models (`sonnet-5`, `anymodel-coder`, `gemini-3.8-flash`), then lix
(the second provider, `https://lix.autos/v1`), then whatever else the catalog
has. A provider with no stored key has no models in the catalog and contributes
nothing, so a fallback can never invent a provider that does not exist. The
current model is excluded by identity (`provider/id`), never by variant: another
variant of the same model fails the same way (a 401 on `sonnet-5` is a 401 on
`sonnet-5#max` too). Dead Anymodel models (`anymodel-v4.1-flash` et al.) never
appear. The switch is announced in the session itself, naming the real
provider. lix is seeded by the `orchestra.provider.lix` plugin
(`packages/core/src/plugin/provider/lix.ts`): registered but never available
without a stored key, models discovered live from `/models` once the key exists.

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
- **Worker activation**: a dispatch does not trust the prompt's advisory wake.
  `Orchestra.dispatch` (`packages/core/src/orchestra.ts`) forks an explicit
  `sessions.resume` one second after the prompt (the same workaround
  `Federation.brief` already used for fresh sessions) and starts an activation
  watch (`packages/core/src/session/activation.ts`): a durable KV record
  (`orchestra/activation/<sessionID>`) with the dispatch time, then a check
  after N minutes (default 5, `ORCHESTRA_ACTIVATION_CHECK_MINUTES`, clamped
  1–60). Started means input tokens > 0 or a live execution claim. A worker
  that has not started is resumed once and checked again; if it still has not
  started, the watch escalates to the Orchestrator with a durable
  `<activation-failure>` synthetic message, using the existing error ladder
  (`SessionEscalate.ladder`), never a human confirmation. A held worker is
  left alone (the hold release wakes it); a run that ended failed/interrupted
  is left to its own reporting, and a run that "succeeded" with zero tokens
  and work still pending counts as not started. The planner is watched the
  same way from `Federation.createSociety`: a delivered kickoff starts a watch
  on the planner main session, escalating to the Society chat when the planner
  never starts.
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
  answer / resolve / nextCard / delivered / failed / tick / sweep / heartbeat /
  raiseDispute / resolveDispute / escalateDispute`,
  helpers `retryLater`, `applyReceipt`, `createCard`, `enqueue`. Event dedup
  by `(source, key)`; claim by token (repeat claim returns the same run);
  idempotent `finish` (same receipt → same answer, different receipt under
  the same token → conflict). Orchestra limits instead of the original's:
  retries 1–2 (was 10), check rounds max 5 (`verifyIterations` on the run,
  then an ask card), `MAX_HOPS = 8`, `RESEND_AT = [0,1,3,7,15,25,35,45,55]`,
  57-minute window. Rules come from Orchestra config via the `decide`
  environment, never from a `rules.json`. Minimal five-field cron parser
  lives here too (tick needs it). Sweep: a run its worker stopped mentioning
  goes `claimed → unknown` once its lease is out, whether the worker is
  still around or already gone; while the worker stays gone (no heartbeat
  past `workerFreshMinutes`) its unknown runs go back to the queue
  (`unknown → queued`, claim cleared, `not_before` now), so a dead worker
  never blocks a lane forever — a live worker keeps its unknown runs, it may
  still finish them. The server's startup tick runs this sweep, so a restart
  re-queues dead workers' runs too. Answer: the `card.answered` event
  carries the chosen option in `detail`; answering `Отменить задачу`
  (`CANCEL_OPTION`) cancels the task and starts no new run.
- **Cards (block Б3, подшаг 2)**: `src/autoloop/cards.ts` is the thin layer
  over `store` + `decide` — `listCards` / `listOpenCards`, `createCard`
  (same key while open = duplicate, no new fact), `answerCard` (records
  `card.answered` with the chosen option, starts a new run when the card
  belongs to a rule — except `Отменить задачу`, which cancels the task and
  starts none, `newRunId` null),
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
- **Autoloop safety core (ideas #2, #6, #11, #14, #18 — slice A)**:
  - `kernel/repeat.ts`: the stop-word on a deadlock. `fingerprintError`
    normalises error text (numbers, hex, UUIDs, timestamps, quoted strings,
    paths) so the same failure compares equal across attempts; `recordRepeat`
    counts consecutive repeats and repeats inside an hour. A run whose error
    repeats 3 times in a row or 3 times within an hour stops in `retryLater`
    even when retries remain, with a stop card naming the error, the attempt
    count and the fingerprint. The fingerprint and the history stay on the
    run row (`error_fingerprint`, `error_repeat`, `error_history`); an empty
    error text never trips it. The session-runner retry caps (Б4/Б5) bound
    one step only — this is the cross-attempt detection they cannot see.
  - `kernel/decide.ts` receipts carry `fixTask` + `failingTest { file, run }`
    (idea #6): a run that declares itself a bug fix must attach the failing
    test that reproduces the bug, or the "done" counts a verification round
    instead (after 5 rounds the run stops with an ask card). The proof is
    recorded on the run row (`fix_test_file`, `fix_test_run`) and passes
    through `receiptForReport` in `src/autoloop/orchestrator.ts`. The gate
    keys on the declaration — the kernel cannot tell a fix task from other
    work, and guessing from the text would misfire.
  - `kernel/decide.ts` `retryLater` writes exactly one lesson on the second
    failed receipt (idea #11) into the `lessons` collection (`run`, `rule`,
    `text`, `error`, `fingerprint`, `attempts`): attempts only grow, so
    `attempts === 2` fires once per run. The journal is the durable shared
    memory the society reads through `getView` — the three-level memory of
    Б17 does not exist yet and the kernel is pure, so the lesson cannot go
    to the Memory service from here. The lesson names the error, not a
    verdict about its cause.
  - `kernel/decide.ts` receipts carry `verification` (idea #14), entries
    `{ kind, detail }` with kind one of `VERIFICATION_KINDS` (`test`,
    `command`, `manual`, `review`, `transcript`). A done receipt that
    declares verification must carry at least two entries of different
    kinds, or it counts a verification round instead; declared methods are
    recorded on the run row (`verification`) and pass through
    `receiptForReport`. A receipt that declares nothing is exempt by
    design: legacy receipts and read-only work have no second method to
    declare. Unknown kinds are rejected, so a typo cannot pass as a second
    method. The live wiring that fills `verification` from
    `orchestra.ts` `report()` (the worker's CHECKS + the transcript
    evidence) is not done yet — the two signals already exist there, the
    bridge only has to pass them.
  - `kernel/dispute.ts` + `decide` inputs `raiseDispute` / `resolveDispute` /
    `escalateDispute` + the `disputes` collection (idea #18): the dispute
    ladder agent (15 min) → group-leader (30) → council (60) → orchestrator
    (120) → operator, moving up on its own in `sweep` when a level's time
    runs out, carrying both positions. Reaching the operator writes one
    notice card (`dispute:<id>:operator`) and marks the dispute `noted` —
    a record for the operator, never a block and never an approval gate.
    The ladder is re-exported from `src/session/runner/escalate.ts` as
    `DisputeLadder` next to the error ladder: errors climb when retries
    and fallbacks are exhausted, disputes climb when time runs out.
- **`kernel/due.ts`**: `RUN_LEASE = 5 мин`, `WORKER_FRESH = 2 мин`,
  `OFFLINE_AFTER = 10 мин`, `SEEN_EVERY = 1 мин`, `deadlines`,
  `offlineCard`, `workers` / `waitingOn` (unknown runs count as waiting).
  `deadlines` also wakes the clock for a dead worker's runs: a lease due for
  a stale claimed run, a `requeue` due for an unknown one.
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
- **Shadow orchestrator (idea #8)**: `src/autoloop/shadow.ts` is the
  mechanism only — no model, no judgements of its own. `collectDecisions`
  reads finished runs / answered cards / recorded events for a day from a
  `View` (kernel files untouched, journal read-only); `summarizeDecisions`
  counts outcomes, agents, rules, failures and retries;
  `renderSessionPrompt` builds the shadow session's template (a
  disagreement needs a journal fact with its `run:<n>` / `card:<n>` /
  `event:<n>` id); `renderDigest` / `renderDigestFromDisagreements` compose
  the digest; `writeSessionPrompt` / `writeDigest` store it under
  `<data>/society/shadow/` as `shadow-prompt-YYYY-MM-DD.md` /
  `shadow-digest-YYYY-MM-DD.md`. The digest content is written by an
  agent session. Daily trigger is `script/shadow-digest.ts` (`--prepare`
  / `--finalize --session-text <file>`, `--db` / `--society-dir` override;
  the DB is opened read-only) plus a system cron line — the server has no
  scheduler for arbitrary scripts. Docs: `docs/shadow-orchestrator.md`.
  Tests: `packages/core/test/autoloop/shadow.test.ts` — fabricated views,
  no DB.

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
  Known-slow tools get more from the per-tool table (`executionTimeoutFor`):
  serena `initial_instructions`/`serena_repl` and deepwiki `ask_question`
  run 10 minutes; explicit per-server config still wins over the table.
  Transient failures retry for read-only tools and for calls the caller marked
  idempotent (`idempotencyKey`); other calls run exactly once.
- `index.ts`: a server that dies on its own is restarted up to 3 times with
  growing delays (5s/15s/30s), then stays failed; explicit stops never restart.
  The circuit breaker (`catalog.ts`, `McpCircuitBreaker`) is wired into the
  call path: 3 failed calls or connects in a row pause the server (fail fast
  with a named message instead of hammering it), a successful call or
  connect clears the pause, and the catalog plugin hides paused servers from
  session context. Needs-auth is an operator state, not a failure, so it
  never counts toward the breaker.
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
- B7 (desktop isolation): agent-desktop and playwright are `realScreen` servers.
  They are never acquired (`acquire.ts: ensure()`) nor called (`index.ts:
  MCP.callTool`, the choke point for every MCP tool call) while the real-screen
  opt-in is invalid — even when installed by hand in the config. The selector
  (`select.ts`) still matches them; the gate lives in acquire/call, not in ranking.

## SSRF gate — `packages/core/src/tool/ssrf.ts` (Б13, extended in G2-2)

- One shared gate for every outgoing URL: `Ssrf.assertPublicUrl` (Effect),
  `assertPublicUrlPromise` (plain async), `assertPublicLiteralUrl` (sync, no DNS).
  It refuses non-http(s) URLs, local hostnames (`localhost`, `*.localhost`,
  `*.local`), literal private/loopback IPs, and hostnames that resolve to a
  private address. DNS failure fails closed. Deliberately not blocked:
  198.18.0.0/15 (benchmarking space — the sandbox resolver answers public names
  from it) and the TEST-NET documentation ranges.
- Guarded call sites: `webfetch` (every URL and every redirect hop), remote MCP
  connect (`mcp/client.ts` — the checked URL is the one the transport dials),
  provider discovery (`provider-discovery.ts` — the gate runs before the API key
  is attached to any header), MCP Forge validation + `fromOpenApi` (literal
  check) and the generated runtime (its own embedded copy of the gate, because
  generated code cannot import Orchestra modules; redirects followed by hand,
  one hop at a time), Code Mode fetch (`codemode/web.ts`, manual redirects),
  MCP OAuth discovery/token fetches (`mcp/oauth.ts`), and `mcp_forge` remote
  registration (`tool/plugin/mcp-forge.ts`).
- `allowPrivateUrl` is a test-only escape hatch for loopback fixture servers
  (`mcp/index.ts` layer options → pool → client → oauth). Production callers
  never pass it; a remote MCP server on a private or loopback address is refused
  unless the caller explicitly opts in.
- Not gated, by design: fixed hosts and operator-configured instance URLs
  (`plugin/provider/*`, ollama/lmstudio fixed origins), operator pairing room
  URLs (`peer.ts`), CLI-operator URLs (`session/import.ts`, updater env URL,
  gateway upstream), and the same-origin browser POST in `oauth/page.ts`.

## Desktop isolation — `packages/core/src/desktop-isolation.ts` (block Б7)

- The agent never touches the operator's real screen, mouse, or clipboard.
  Every `desktop_*` action runs on the agent's own virtual display — Linux: a
  separate Xvfb display (`:99` by default, `ORCHESTRA_VIRTUAL_DISPLAY` to
  change it), `DISPLAY` pinned to it for every spawned child (screenshot,
  input, clipboard, `xdg-open`). A screenshot can only ever show the virtual
  screen. macOS and Windows have no virtual display (G2-9): the `desktop_*`
  tools refuse there with a plain-language error ("no virtual display")
  unless the operator explicitly opted the real screen in — they never run
  silently on the real screen. Windows keeps its PowerShell helper and
  playtest's hidden/behind ladder behind that same opt-in.
- `ORCHESTRA_DESKTOP_CAPTURE=on` means ONLY "the virtual display is allowed".
  The real screen needs a separate explicit opt-in: `ORCHESTRA_DESKTOP_REAL_SCREEN=on`
  AND `ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST` (comma-separated app names) AND a
  future `ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL` (ISO date). Any piece missing,
  expired, or not naming the app → the action is refused with a plain-language
  error, never run "somehow". Rollback is a deny: remove the opt-in and every
  real-screen path refuses.
- Gated by that opt-in: `desktop_*` itself on macOS/Windows (G2-9 platform
  gate: `desktopPlatformDenial`, Linux always passes), `desktop_action`/
  `desktop_inspect` (Windows UI Automation has no virtual display), playtest
  `input: real` / `mode: visible` (in any session, not just silent ones),
  `zen_browser` (all actions except `status`), MCP `agent-desktop`/
  `playwright` (acquire + callTool), and shell escapes (`xdotool`/`ydotool`/
  `wtype`/`screencapture`/`grim`/`scrot`/`xwd`/`import -window`/bare `import`/
  `gnome-screenshot`/`flameshot`/`spectacle`/`xclip`/`xsel`/`wl-copy`/
  `wl-paste`/`pbcopy`/`pbpaste`/`osascript`/`cliclick`/`pyautogui`/`pynput`/
  `pywinauto`/`xprop`/`xwininfo`/`wmctrl`/`adb`/PowerShell `SendKeys`/
  `SetCursorPos`/`mouse_event`/`keybd_event`/`CopyFromScreen`/clipboard,
  explicit `DISPLAY` to anything but the virtual display). The shell gate
  applies to the shell tool AND the hub tool (both run `shell.create`; the
  hub's `prepare` calls the same `forbiddenDesktopEscape`). Shell-spawned GUI
  apps get `DISPLAY` pinned to the virtual display when capture is on (Linux).
- Virtual-display state is a journal fact (`journal.ts`: `recordDisplayEvent`,
  type `desktop.display`, states `started`/`alive`/`died`): which display, whose
  session, and a death is an event, never silence.
- Opens are deduplicated (block Б4, `tool/idempotency.ts`): `desktop_open` and
  `zen_browser navigate` open a URL once per session, even across re-entry.
- Regression tests that must run on every commit touching `desktop*` /
  `zen-browser` / `shell` / `playtest`: `test/tool/desktop-virtual-display.test.ts`
  (a secret window on the host display is invisible on the agent screenshot;
  a link opens once across three calls and not again after re-entry) and
  `test/tool/desktop-isolation.test.ts` (gate decisions, shell escapes, MCP
  acquire refusal). A new screen-access path (new tool, new MCP server) must
  pass the gate — checklist item in review.

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

### The Society feature (`society_forge`) — `packages/core/src/society.ts`, `federation.ts`

A Society is founded from a goal (`society_forge found` → `Federation.createSociety`):
a planner project plus an optional team project. The planner plans in its first
messages and builds the rest with `society_forge generate` and `society_plan`.

- Base projects come from the operator's `orchestra.society.baseProjects` config
  when it is set and complete, otherwise the built-in four (planner, architects,
  coders, testers). A configured entry missing a field falls back to the built-ins.
- A project created from a built-in team template opens one worker per template
  role at once — in `createSociety` for the team project and in `generate` for
  base and extra projects — never zero workers. Operator-saved templates open
  their saved roster at creation instead.
- Before anything is created, `createSociety` runs the provider preflight
  (`SocietyPreflight.checkLive`, `packages/core/src/society-preflight.ts`):
  an Anymodel key must be stored (credential store first, provider settings
  second) and alive (`GET /models`), and the planner's model must be served.
  A failed preflight refuses the creation with the fix named; without
  Credential/Provider services in the layer the check is skipped, never a
  false failure. The same preflight runs at server boot (logged, never
  blocking boot) and gates `resumeGeneration`: a Society whose provider is
  dead is not woken.
- The team workers are counted, not assumed (`openSocietyTeam`): one retry
  per failed role, then a live read-back of every opened session. The
  creation result carries `team: {expected, opened, live, failedRoles,
  unverifiedRoles}`. Zero live workers fails the creation and rolls it back;
  a partial team stands, with a warning, for the planner to top up.
- Generation is tracked in the federation KV store (`founded` → `generated` →
  `planned`, forward only): `generate` records `generated`, `society_plan apply`
  records `planned`. The goal is delivered to the planner with confirmation
  (retried); a `founded` Society whose planner never generated is resumed on
  startup (`resumeGeneration`, same message id, so the goal is delivered once).
- Readiness is code, not a prompt: `societyStatus` counts living agents (target
  30, minimum 21), agents with a model, chats with a recorded budget, and the
  generation stage, and names what is still missing. A Society is ready only
  with more than 20 living agents, every one with a model, `society_plan apply`
  run, and at least one recorded budget.
- `society_plan apply` is all-or-nothing (validate everything, then apply, rolling
  back on a midway failure) and stores the plan per project, so workers created
  later inherit the model, context threshold, cache switch, budget and the one
  MCP assignment for the whole Society. Budget is a field (`orchestra.budget-tokens`),
  not prose. Rules reach new projects by scope (`society:<name>`).
- Model table (`society.ts`, verified against Anymodel 2026-11-05): strong
  `opus-5.5`, mid `sonnet-5.5`, cheap `anymodel-coder` (quality work), fallback
  `sonnet-5`. Dead models (`anymodel-reasoner`, `anymodel-v4.1-flash`, `fable-5.1`,
  `gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol`) are never a primary or a fallback;
  `workerModels` also gives cheap work the cheap model instead of the
  Orchestrator's flagship. Building the Society (`society_forge found/generate`,
  `society_plan apply`) is exempt from the 6-message rule and resets its count;
  the orientation limit is ten calls with investigation as a valid first dispatch;
  MCP deny rules are replaced per dispatch, never piled onto a reused worker;
  the Orchestrator's reconnaissance travels to the worker whole.
- Federation tickets wake their target the same way: `tell`
  (`packages/core/src/federation.ts`) forks the same one-second explicit
  resume after the prompt, so a ticket delivered to a freshly created
  Orchestrator cannot strand the Society. Releasing a hold
  (`Federation.setHold(name, false)`) now resumes the Society's sessions that
  still have pending inbox work — previously the release only removed the hold
  key and nothing re-woke the parked sessions (the startup sweep runs only at
  boot).
- A kickoff that never lands is retried, not lost: `tellConfirmed` logs the
  failure reason instead of returning a silent `false`, and `createSociety`
  forks one more `resumeGeneration` retry after the activation delay when the
  kickoff was not delivered, logging an error with the manual fix if it still
  has not landed. `resumeGeneration` itself still re-sends while the Society
  is `founded` (same message id, so the planner's inbox keeps one copy).

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

## Block Б8 — projects, chat, storage (durability)

Nothing silently disappears: lists page past the KV 1000-entry scan limit,
the front never overwrites a non-empty store with an empty refetch, and SSE
replay keeps 4096 events and signals `server.replay-gap` when a client fell
too far behind, so it resyncs instead of missing events.

- **Pagination**: `packages/core/src/federation.ts` scans KV with `scanAll`
  (follows `next` past 1000 entries) for groups, links, activity, holds and
  council rounds; `packages/core/src/orchestra.ts` does the same for projects
  and for saved roles/templates (`scanAll`, used by `projects()` and
  `stored()`); `packages/server/src/handlers/session.ts` pages session
  lists; the app loads the whole session index and pages archived sessions by
  cursor. `Orchestra.outcomes` returns every report of each worker, oldest
  first — not only the latest — so earlier reports are never overwritten in
  the view (each report is its own KV entry under `orchestra/report/`).
- **Chat**: `session.prompt` returns `{data, held}` — `held: true` means the
  prompt was admitted but the session is paused (hold), so the client shows
  "Session is paused" instead of silence. The composer retries a failed send
  up to 3 times with backoff (0/500/1500 ms) reusing the same admission id,
  so the server's idempotent reconcile never duplicates the message.
  A stream interrupted after the first tokens publishes a failed receipt
  with the partial output and continues in a new round. Resume-on-start
  resumes only when the autoloop journal says the run did not finish
  (`packages/core/src/journal.ts` — `hasUnfinishedRun`).
- **Storage as data**: `society_plan apply` stores planner decisions
  (role, model, context, cache) in KV under
  `federation/society-plan/<group>/<project|society>/<role>` and `status`
  reads them back plus spend aggregates per project and for the whole
  society. A federation group carries an optional USD `budget`, kept across
  rewrites and checked on apply. Errors go to the autoloop journal
  (`recordError`, journal-only facts, `type: "error.recorded"`) — wired
  from the session runner (stream interrupted) and file mutation (write
  failed, after rollback).
- **Project identity**: a project's orchestra ID is pinned in
  `.orchestra/project.json` (read only for folders without repository
  markers); `dod.yaml` is versioned in git while `.orchestra/` memory and
  notes stay ignored (`.gitignore` split in the repo root and in
  `ensureProjectGitignore`).
- **Database backup**: `packages/core/src/database/backup.ts`
  (`backupDatabase` via `VACUUM INTO`, `restoreDatabase`, only while the
  server is stopped) and `PRAGMA synchronous = FULL` for critical writes.
  Durable events persist by default (G2-7: `Bus` keeps payloads unless
  `persist: false` is passed explicitly — a plain `orchestra serve` used to
  drop them on restart). Backups run themselves (G2-8): the Node server takes
  one at startup — before the startup hold resumes Societies — and then one
  every 6 h into `<data>/backups`, keeping the 7 newest (`ServerOptions.backup`
  to tune, `packages/server/src/database-backup.ts`); a file database with
  pending migrations is snapshotted before the migration runs
  (`DatabaseMigration.pendingMigrations`, best-effort, never fails the boot).
  Restore is atomic: the backup is verified (magic header +
  `PRAGMA quick_check`) before the live file is touched, the live file and
  its `-wal`/`-shm` sidecars are moved aside to
  `<database>.pre-restore-<timestamp>` instead of deleted, the copy is
  verified again, and a failed copy or verification moves the live database
  back — a corrupt backup can no longer destroy the live database. Rotation
  (`pruneBackups`) deletes only old timestamped backup files.
  `restoreDatabase` still needs the server stopped: an open connection would
  keep writing to the replaced inode.
- **Atomic file writes**: `packages/core/src/file-mutation.ts` writes via a
  temp file + rename under a cross-process lock file
  (`<target>.orchestra-lock`, stolen when the owner pid is dead or the lock
  is older than 30 s), snapshots the previous bytes and rolls back on
  failure; symlinks are written directly under the same lock with a
  snapshot.

## Forges — `packages/core/src/tool/plugin/`

`team_forge`, `workspace_forge` and `society_forge` create projects, teams and
roles from specs at runtime. All worker creation goes through
`Orchestra.workerModels` **with** `{ favorites, catalog }` (see the AI standard
section). A forge that creates a worker without them is defective.

## Rules as code — `packages/core/src/rules.ts`

Standing rules are data in KV (`rules/<scope>/<id>`), not prompt text, and they
are enforced in code. Scopes: `society:<name>` > `project:<id>` > `global`;
a cross-scope contradiction fails with `Rules.ConflictError`, never left for
the model to resolve. A rulebook that fails to load fails the request with
`Rules.LoadError` (corrupt entries included) — it never silently becomes
empty. Scope resolution walks the session's parent chain, includes `lead`
groups, and a sandbox inherits its source project's rules (and that project's
societies). At society creation the society's rules are handed to every member
project's main session as a queued `<society-rules>` inbox message
(`createSociety`, `federation.ts`). Operator rules are protected: a worker
cannot remove or rewrite them (`Rules.ProtectedError`), and every edit is
recorded in `rules/history/`. A saved "always allow" never beats a newer deny
— denies are checked first in `evaluateInput` and `confirm`. The completion
gate (`session/completion-gate.ts`) checks after every answer: work the turn
claimed is not DONE until `dod verify` says so, and a hand edit of the DoD
board, a protected file, or a credential dump in the same turn is flagged. Rules survive compaction: the summary keeps
a `Rules / DoD / Errors` section, the context governor never elides a
`rules list` result, and prefix-pin reports rule changes as a diff.

A new Society starts with six default rules (`Rules.DEFAULT_SOCIETY_RULES`,
seeded by `createSociety` into an empty society scope only): ask three questions
before coding, write an ADR for big decisions, write a handoff before any stop,
30-minute read-only cold start, riskiest part first, record verified outcomes in
the knowledge map. Seeding is idempotent and never rewrites a Society's own rules.
Two of those rules also live as built-in session instructions
(`core/ask-first`, `core/riskiest-first` in `instructions/builtins.ts`), so a lone
session without a Society hears them too.

## Independent review — `packages/core/src/review/`

The mechanism for a second pair of eyes, not the review itself: these
modules are the record and the rules around it. The review content (the
findings, the marks, the votes, the walked scenario) is written at runtime
by the reviewing agents; nothing here simulates an agent or fakes a pass.
All five modules are pure (no Effect, no I/O, no model calls); persistence
and the runtime prompts that tell a reviewer what to attack live outside
them.

- Red team (`review/redteam.ts`, idea #1): `startReview` opens a review of
  a plan/architecture artifact by a group that did not write it (same
  reviewer as author is refused). Every finding stays `open` until
  `addressFinding` (with a reference: commit, plan change, test) or
  `dismissFinding` — a dismissal without a reason is refused. Blocking =
  open `critical`/`major`; open `minor` findings are recorded but never
  block on their own.
- Dual architecture check (`review/dual.ts`, idea #9): `startDualReview`
  opens two separate review records with no shared state; the two reviewers
  must differ from each other and from the author. `merge` matches open
  findings by explicit `key` first, else by normalized summary, and ranks
  common findings first. Blocking = any common finding, or any single-sided
  critical/major one. The orchestrator must run the two reviews in isolated
  sessions — this module cannot enforce that; a merge of two reviews written
  by one agent in one session is not a dual check.
- Foreign checklist review (`review/checklist.ts`, idea #7): the reviewer
  group is assigned by `assignReviewer` (first roster group that is not the
  author's; deterministic) and must differ from the author group.
  `fromDod` builds one step per checklist line from the DoD board through
  its public `Dod.Status` shape only — `dod.ts` is never edited here.
  Verdict is `pass` only when every step passed, `fail` when any step
  failed (a fail needs a reason), `pending` while any step is unmarked.
- User-eyes acceptance (`review/acceptance.ts`, idea #17): `startRun`
  records a user scenario and its steps in order; `recordStep` marks each
  step pass/fail with evidence of what the agent actually saw. `mayShip`
  is true only when the run passed, or was explicitly `defer`red with a
  reason — a deferred run unblocks delivery but stays recorded as deferred,
  never as passed.
- Evidence-weighted voting (`review/vote.ts`, idea #5): a vote weighs 1 +
  best evidence (test/measurement +2, document +1, opinion +0); one vote
  per voter, a re-vote replaces the earlier one. `selectJury` draws three
  agents with a seeded PRNG from the candidates minus the interested
  parties; `decide` needs all three jurors' votes, a tie is recorded as a
  tie, never silently broken. Standalone by design: Orchestra has no
  decision stream to wire into — the council is consult-only, "no project's
  vote is binding" (`packages/core/src/plugin/agent.ts`), so the
  `tally`/`decide` record is the decision. Wiring a binding vote into
  federation would change product policy.

Enforcement — `packages/core/src/session/completion-gate.ts`: `planGate`
accepts a plan/architecture for coding only when its red-team or merged
dual review has no open blocking finding; `check(..., reviews?)` takes an
optional `ReviewGates` (`redTeam`, `dual`, `checklist`, `acceptance`) and
refuses to let the session stop while any passed-in review blocks. The
gates are off unless the caller passes a record — the gate enforces only a
review the session actually opened.

Verify: `bun test test/review/` from `packages/core` (40 tests).

## ADRs — `packages/core/src/adr.ts`

Big decisions are written down once, in `.orchestra/decisions/adr-NNNN.md`
(Context, Decision, Alternatives considered with why each lost, Consequences),
with `create` / `list` / `read` / `search` over the project's directory. Numbers
come from the files already there; a file that does not parse as an ADR is skipped,
never fatal. This layout is the one the .orchestra-files block (B16) must adopt
when it lands — there is no second decisions directory. The orchestrator's
standing prompt points here (`plugin/agent.ts`), and the default society rules
make writing one mandatory before the implementing code.

## Session handoffs — `packages/core/src/session/handoff.ts`, `session/execution.ts`

Before any pause or stop, the agent writes `.orchestra/sessions/<id>/handoff.md`
(where it stopped, what works, what does not, the next step) — a default society
rule. The execution layer also writes one: on an interrupted or failed terminal
outcome it leaves a *stub* (marked `<!-- orchestra-handoff-stub -->`, with
"(not recorded)" placeholders) when no handoff exists, refreshes an existing stub,
and never overwrites an agent-written handoff. Writing the stub is best-effort
inside settlement: an interruption stays an interruption, anything else is a
warning. The layout follows the three-level memory design (L3, session level);
`memory.md` in the same folder is not this module's job.

## Sprint cold start — `packages/core/src/sprint.ts`

`Sprint.start` opens a 30-minute read-only phase for a project, recorded as a
marker file `.orchestra/sprint.json` (`startedAt`, `readOnlyUntil`, `minutes`,
`startedBy`); `isReadOnly` / `remainingMs` / `checkWrite` read it, `end` closes it
early. A corrupt phase file reads as no phase, never a stuck one. The phase is
enforced by the default society rule and by `checkWrite` (which refuses `edit`,
`write`, `patch`, `shell` with the minutes left) — it is NOT a hard gate on the
tools themselves: the write tools each check Permission on their own path, with no
shared choke point, so a model that ignores both the rule and `checkWrite` can
still write. The marker makes the violation visible; it does not make it impossible.

## Knowledge map — `packages/core/src/knowledge-map.ts`

Who is strong at what, by verified outcomes, not by claims. KV keys
`knowledge-map/<scope>/<agent>` (`project:<id>` or `society:<name>` scopes, never
shared across them) hold per-area scores: +10 per DONE, +5 more when done on the
first try, −5 per FAILED, clamped 0–100, starting at 0. `record` / `get` / `list` /
`bestFor` (highest score, then most tasks; agents with no record in the area are
not ranked). The only writer wired in is the `dod` tool: on `verify`, a DONE or
FAILED item records the outcome for the verifying agent in the item's stage (its
group; "general" when ungrouped), detached via `Effect.forkDetach` and skipped
entirely in layers without KV — the board already says DONE/FAILED, so a map
write never turns a verify call into a failure. No code assigns tasks by skill
yet: `bestFor` is the query API waiting for that consumer (follow-up).


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

## Health endpoint & honest model catalog (G2-6)

- `GET /health` — `server.health` in `packages/protocol/src/groups/server.ts`,
  handler `packages/server/src/handlers/server.ts`, probes
  `packages/server/src/health.ts`. 200 `{status:"ok",
  checks:{database,bus,autoloop}}` only when all three answer; otherwise 503
  `ServiceUnavailableError` naming the first dead component. Database is
  `SELECT 1`; bus is an ephemeral `health.ping` round-trip (nonce, forkScoped
  subscriber) plus a durable log drain; autoloop is `stats()` + `getView()`
  (ticks stay 0 on an idle server by design — not a failure). The body carries
  no secrets, paths, or provider details.
- Unauthenticated by design (monitoring polls it): skip-listed in
  `packages/server/src/middleware/authorization.ts` AND in `dispatch` in
  `packages/server/src/process.ts` (the Node server's own auth runs before the
  middleware). Routed to the API in `packages/cli/src/services/web-ui.ts` —
  never the SPA fallback that used to answer 200 with `index.html`.
- Catalog honesty: a config provider without a key is NOT "enabled"
  (`packages/core/src/config/plugin/provider.ts` stamps `"enabled"` only for a
  literal non-empty `apiKey` in settings — the same rule `Model.default()` in
  `packages/core/src/model.ts` uses). `Provider.available()` /
  `Model.available()` / `model.default()` therefore only ever see providers
  with a verified key or credential; a configured default on a dead provider
  is ignored, never silently served.
- Missing folder: `requireLocationDirectory()` in
  `packages/server/src/location.ts` triggers the FileSystem probe before
  `awaitActivation` in the model/provider/integration handlers, so catalog
  reads answer 404 `LocationNotFoundError` instead of a confident 200.
  `Project.resolve` no longer creates a missing folder:
  `packages/core/src/project.ts` `ensureBinding` skips the binding write when
  the directory does not exist — a resolve is a read; the binding is written
  on the next resolve after the folder appears.
- Verify: `packages/server/test/g2-health.test.ts`,
  `packages/core/test/g2-health-model-catalog.test.ts`,
  `packages/server/test/fetch.test.ts` ("returns LocationNotFoundError…").

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
- Mutation testing (idea #15): `bun script/mutation-check.ts <target>
  <test>` mutates one comparison / condition / constant / `&&`|`||` at a
  time, runs the tests on each mutant in a temp copy of the package (the
  working tree is never touched), and reports survivors — tests that stay
  green. Exit 0 only when every mutant is killed. Critical modules —
  autoloop kernel, rules, DoD, completion-gate, SSRF gate, key encryption —
  get a mutation-check run whenever their logic changes; a survivor is a
  task (write the catching test or record why the mutation is harmless).
  Docs: `docs/mutation-check.md`.
- Clean build (idea #16): `script/clean-build.sh` builds the project from
  scratch in a fresh worktree (install, build schema/protocol/core/server/
  cli, typecheck, lint; `--tests` adds core tests, `--smoke` is install +
  typecheck core only). A handover counts as done only with a passed
  clean-build recorded in `.orchestra/clean-build-log.md`
  (`--record` writes it). Full typecheck needs >= 16 GB; on the 8 GB VM
  use `--smoke`. Docs: `docs/clean-build.md`.

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
