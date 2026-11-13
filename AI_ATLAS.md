# AI Atlas — orchestra-app

The whole application as one instruction map for an AI working in this repository.
`AGENTS.md` holds the rules (style, Effect conventions, architecture layers, testing).
This atlas holds the _map_: where each system lives, what it guarantees, how to change
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

| Area             | Path                | What it is                                                                                                                                                 |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schemas & domain | `packages/schema`   | Serializable entities: config, modes, roles, teams, interactive blocks. Zero internal deps.                                                                |
| HTTP contract    | `packages/protocol` | `Effect.HttpApi` endpoint groups, incl. federation groups (`src/groups/orchestra.ts`).                                                                     |
| Generated client | `packages/client`   | Regenerate with `bun run generate` after Protocol/Server HttpApi changes; never hand-edit.                                                                 |
| Domain engine    | `packages/core`     | Sessions, runner, tools, MCP, federation, forges, the AI standard. Prompt intake (`src/prompt-intake/`) deep-processes every user prompt before admission. |
| Providers/models | `packages/ai`       | Model transports, provider adapters (incl. the Zen provider), streaming.                                                                                   |
| Server           | `packages/server`   | HttpApi handlers (`src/handlers/*`), SSE, authorization.                                                                                                   |
| CLI & service    | `packages/cli`      | `orchestra serve`, background-service lifecycle, web-UI assets. Recovery mini-chat page (`services/recovery-page.ts`, served at `/recovery`).              |
| TUI              | `packages/tui`      | SolidJS/OpenTUI interface: dialogs, sidebar, composer, themes binding.                                                                                     |
| Web/desktop app  | `packages/app`      | Web UI; question dock, transcript. Built assets are served by the CLI in production.                                                                       |
| Themes           | `packages/theme`    | Theme registry, TUI token resolution and readability floors.                                                                                               |

## The single AI standard — `packages/core/src/ai-standard.ts`

One place decides how AI runs when the operator does not say otherwise. The operator
states the task and keeps a shortlist of favorite models (the picker's **Feature**
section, config key `model_favorites`). Everything else is derived.

- Priority chain for a worker's model: the task's explicit model → **favorites,
  ranked** (`rankFavorites`: depth work takes the highest-effort variant first, speed
  work the cheapest first; `effortFor` classifies by role category+name) →
  the role's own model → the `orchestra.worker` policy (category entry before the
  general one) → inherit the caller's model. Unavailable models are skipped, never
  retried blindly, and dropped from fallbacks too. So are the favorites of a
  provider inside a recorded cooldown (`AiStandard.downProviders`, read from
  the `ProviderCooldown` map over the catalog when `workerModels` gets no
  explicit list): a 502 marks the whole provider down for a minute, and the
  pick moves to a live provider while the favorites list itself never changes.
  The role's own model keeps its exemption from that guard, like the
  dead-model guard — the author's deliberate choice, covered by the runtime
  fallback.
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
(the second provider, `https://lix.autos/v1`), then klinch (the third,
`https://klinch.cloud/v1`), then whatever else the catalog has, sorted by
provider then model id — never in catalog order, so the order does not
depend on registration order. A provider with no stored key has no models in the catalog and contributes
nothing, so a fallback can never invent a provider that does not exist. One
verified model is an exception to "in the catalog": `anymodel-coder` left the
Anymodel `/models` listing on 2026-11-07 (run10) but still answers live chat
(45 tokens), so the chain keeps offering it while the catalog holds any
Anymodel model at all — chat is the real proof, the listing lags. The
current model is excluded by identity (`provider/id`), never by variant: another
variant of the same model fails the same way (a 401 on `sonnet-5` is a 401 on
`sonnet-5#max` too). Dead Anymodel models (`anymodel-v4.1-flash` et al.) never
appear. The switch is announced in the session itself, naming the real
provider. Anymodel, lix and klinch are all seeded by their provider plugins
(`packages/core/src/plugin/provider/anymodel.ts`, `lix.ts`, `klinch.ts`):
registered but never available without a stored key, models discovered live
from `/models` once the key exists.

Why G2-14 did not save the Б14 Probe Runner (role-toolkits fix, 2026-11-06):
the chain ran for main sessions only — a worker's operator-given list was used
alone — and `fallbackModel` refused every retryable cause, so a 502 retried
the same dead provider twice and then failed without ever switching. Now the
live-catalog chain is appended AFTER a worker's own list, so an exhausted list
crosses providers; `fallbackModel` no longer re-checks retryability, because
`step.ts` only calls it after the retry policy already declined (retries
spent), so a retryable cause there means "change the model". A gateway failure
(502/503/504) is treated like an authentication failure — the whole provider
is down, not one model — and the retry policy records it in the shared
provider cooldown (`ProviderCooldown.noteProviderDown`), so the chain also
skips providers that are cooling down from a 429 or a 502 this process
already saw.

## Token economy — tool pruning + verify-loop early stop (`packages/core/src/session/tool-pruning.ts`, `session/runner/llm.ts`, `autoloop/kernel/decide.ts`) (TokenEconomizer pilot, run 9)

Two of Microsoft TokenEconomizer's three levers, native in the autoloop —
no foreign code, no external controller. (a) Tool pruning: every loaded
tool's definition is sent with every request, so `runStep` in
`session/runner/llm.ts` stops advertising tools the session has not called
for `toolPruneUnusedSteps` turns (config `orchestra.autoloop.toolPruneUnusedSteps`,
default 10 — TokenEconomizer p=10; the runner reads it from the location
config once per drain, kernel default when no config is in context).
The decision is a pure function of visible history (`ToolPruning.pruneTools`,
`packages/core/src/session/tool-pruning.ts`), recomputed each step, with no
stored state: the clock is assistant turns, a tool is pruned when
`turns - lastUseTurn >= unusedSteps`. It is reversible: a tool named in the
latest user message or the model's latest text is kept, and any call in
history refreshes its last use. Never pruned: `execute` (the gateway to
every MCP/codemode tool), `tools` (the on-demand index), and the tools the
session's mode requires (`Mode.toolsOf`). Only `definitions` are pruned —
the other surfaces already economise themselves: non-core direct tools load
on demand through the `tools` index (`ToolRouter`), and MCP/codemode tools
ride as one `execute` definition plus a catalog summary capped at ~600
inline tokens (`CodeModeCatalog.summarize`). Pruning the catalog text
itself is a follow-up, not this pilot. After a compaction the old calls are
gone from visible history, so a tool used only before the compaction may
look unused and get pruned until mentioned again. The pruning lives in
`runStep`, so it covers the main model steps on every surface — serve, TUI
and CLI all run sessions through the same `SessionRunner`. Two paths still
send the full definitions and are a follow-up, not this pilot: compaction
requests (`session/compaction.ts`) and title generation
(`session/generate.ts`) pass the unpruned snapshot. And for the opencode
provider the transport re-adds `read`, `bash`, `edit`, `glob`, `grep` after
pruning (the Zen validator courtesy in `provider-request-compatibility.ts`
and the Zen mirror in `session/model-request.ts`), so those five are never
actually hidden there. (b) Verify-loop early stop: see the Autoloop journal
section — a check that fails the same way `failureRepeatStop` times (config,
default 3) stops before the 5-round cap. Micro-skills (the third lever —
facts proposed by a reviewer model every k sessions) are NOT built: the
adjacent mechanism that already exists is the one lesson per twice-failed
run in the journal (idea #11); a reviewer-model fact system is a project
decision for a later pilot, not this one.

## Request measurement (Step 0) — `packages/core/src/session/request-measurement.ts`

Opt-in, numbers-only diagnostic for formed LLM requests. Set
`ORCHESTRA_REQUEST_MEASUREMENT=1` (exactly "1") in the daemon's environment
to collect; unset it and nothing is measured or written. It never enables
`ORCHESTRA_REQUEST_REPORT` (the detailed mode that persists prompt text).
Privacy contract: records carry IDs, enum labels, counts and byte/token
estimates only — no prompt text, filenames, URLs, headers, keys or error
bodies, and every record is built field by field, never from spreads of the
request. Files land in `<data>/log/measurements` (override:
`ORCHESTRA_REQUEST_MEASUREMENT_DIR`), one UUID-named `.jsonl` per line,
owner-only (`0700` dir, `0600` files), pruned after
`ORCHESTRA_REQUEST_MEASUREMENT_RETENTION_DAYS` (default 7) - best-effort,
not a deadline: one sweep per hour visits at most 100 entries, so a flooded
directory drains over hours and the rotation offset resets on restart. Coverage:
primary session-step requests only — sizes at request formation
(`recordPrimarySizes` in `session/model-request.ts`), settled by
`session/runner/step.ts` on every outcome branch (completed with
raw usage fields, non-overlapping visible output; catalog-estimated cost
only where usage is complete for pricing and an applicable price tier
exists - partial usage or a missing price stays null, never zero). Only an explicit runner retry
(Retry/RecoverFull/Compacted/Switched) links attempts via `retryOf` and a
shared `logicalRequestID`; any other request starts a new logical request.
The step settles the attempt carried on its `Prepared`. `durationMs`
is elapsed wall time from request formation to step settlement (queueing
and in-step work included), never provider latency.
Export: `bun run packages/core/script/export-measurements.ts [directory]`
folds the local files into one JSON document (manifest + records). Stored
lines are rebuilt through full field validation before export:
object-typed and prose fields are rejected and malformed lines are counted
as skipped; an ID-shaped string is accepted as the ID it claims to be. The
first terminal completion wins (a later one cannot overwrite it) and a begin
can never reopen a settled attempt, so re-export after a restart reproduces
the same ledger. An attempt whose completion never landed (crash, restart,
shutdown mid-request) exports as outcome "unknown" and counts toward
manifest.unfinished: "unknown" means never settled, not failed. Honest gaps: goalID/taskID/role are reserved but unsupported - no
producer passes an assignment, so they are always null with attribution
"unknown". title,
compaction, summary and intake requests are not measured; retries hidden
inside provider SDKs are uncounted; a local attempt ID is not a provider
request ID. This is a diagnostic, never a source of charges.

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
- MCP access is _derived_ from a role, never hand-assigned per run:
  `packages/core/src/mcp/role-profiles.ts` (`fromRole`) maps the role's native
  actions to catalog servers via `impliedTools`/`toolGroups` in the same schema
  file.
- A role with no explicit tool list is NOT unrestricted: `packages/core/src/roles/toolkits.ts`
  (`RoleToolkits`) classifies it into one of seven kinds (orchestrator, scout,
  architect, coder, tester, reviewer, releaser, general) and hands it that
  kind's anchor role toolkit (`effectiveTools`); `plugin/team.ts` pushes the
  resulting permission rules for every role and logs a warning for kind-default
  roles, and the `sessions` tool refuses per-task tools outside the effective
  toolkit. The full map is `docs/role-toolkits.md`.
- `templates` are dynamic team _recommendations_ (roles + playbook); a built-in
  project opens only the Orchestrator, which composes the actual team. Removed
  built-ins survive as `legacyTemplates` for compatibility. A template test pins
  the kept-template roster — update it when adding a template.
- The one fixed-roster exception is `team-solve` (Memdoor team-solve / GVS5H,
  Lee 2026): six roles (`team-planner`, `ideator-a`, `ideator-b`, `team-solver`,
  `team-manager`, `repairer`), each in a fresh session, talking only through
  the ledger (`.orchestra/team-notes.md`) and the DoD board — no shared chat.
  The preset lives in `packages/core/src/team-solve.ts` (roster, 8-step DAG
  plan → two parallel ideators → solve → test → review → one repair → verify,
  `TEAM_SOLVE_MAX_REPAIR_ROUNDS = 1`); the judge is `verdictFromTestRun`,
  which takes only the verification command's exit code — no worker claim or
  vote can pass a task, matching `dod verify` as the only path to DONE.
  Staffing goes through `rolesForTemplate`, one worker per role.
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
  1–60). Started means real progress since the dispatch: input tokens above
  the count recorded at dispatch time, or a turn executing live in this
  process (`Session.active`). A lifetime token total proves nothing — the
  tokens may predate the dispatch — and neither does a durable execution
  claim, which survives a crash and names a dead turn after a restart. A
  worker that has not started is resumed once and checked again; if it still
  has not started, the watch escalates to the Orchestrator with a durable
  `<activation-failure>` synthetic message, using the existing error ladder
  (`SessionEscalate.ladder`), never a human confirmation. A held worker is
  left alone (the hold release wakes it); a run that ended failed/interrupted
  is left to its own reporting, and a run that "succeeded" with no new tokens
  and work still pending counts as not started. Watches die with their
  server, so `Orchestra.recoverPendingTasks` at startup re-arms every
  surviving `watching` / `restarted` record (`SessionActivation.recover`):
  the token baseline is refreshed to the count at recovery time and the
  check cycle is forked again — a watch that already spent its one restart
  escalates instead of restarting a second time. The planner is watched the
  same way from `Federation.createSociety`: a delivered kickoff starts a watch
  on the planner main session, escalating to the Society chat when the planner
  never starts.
- Worker sessions receive `patch` but not `write` in their grant; briefs and
  worker guidance assume patch-first editing.

## Autoloop journal — `packages/core/src/autoloop/`

The native autoloop cycle (block Б2) keeps its state in the journal, not in
process memory. One source of truth, in the existing `orchestra-local.db`.

- **Tables** (`autoloop_facts`, `autoloop_projections`,
  `autoloop_projection_meta`, `autoloop_projection_refs`,
  `autoloop_quarantine`), created by Drizzle
  migration `20261105171218_oval_joystick` (plus `20261106144629_unknown_major_mapleleaf` for the quarantine table) from `src/autoloop/sql.ts`. Never a
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
  **Quarantine** (arch3 A3-11): a poisoned fact is never deleted — the
  journal is the evidence — but `quarantine(seq, reason)` marks it in
  `autoloop_quarantine` and rebuilds the projections in the same
  transaction without it, so it stops affecting decisions at once and no
  later rebuild replays it; `unquarantine(seq)` plays it again the same
  way. A rebuild that skips quarantined facts logs the skipped count.
  Operator commands: `orchestra autoloop quarantine <seq> --reason ...`,
  `unquarantine <seq>`, `quarantine-list` (the mutating two need the
  server stopped, like `db restore`). `openView` falls back to the
  journal's real latest sequence when the stored `last_seq` is damaged
  instead of returning `NaN` (arch3 №51).
- **`kernel/decide.ts`** (block Б3, подшаг 1): pure `decide(view, input, now, env)` — no
  Effect, no I/O. Handlers `ingest / claimNext / started / finish / cancel /
answer / resolve / nextCard / delivered / failed / tick / sweep / heartbeat /
raiseDispute / resolveDispute / escalateDispute`,
  helpers `retryLater`, `applyReceipt`, `createCard`, `enqueue`. Event dedup
  by `(source, key)`; claim by token (repeat claim returns the same run);
  idempotent `finish` (same receipt → same answer, different receipt under
  the same token → conflict). Orchestra limits instead of the original's:
  retries 1–2 (was 10), check rounds max 5 (`verifyIterations` on the run,
  then an ask card) — but a check that fails the same way stops earlier:
  `applyReceipt` fingerprints the gate reason plus the receipt summary and
  stops the run once the same failure repeats `failureRepeatStop` times
  (config `orchestra.autoloop.failureRepeatStop`, default 3), with an ask
  card "Проверка не проходит одним и тем же способом" naming the repeated
  failure and the round count; a check that fails differently each round
  keeps all 5 rounds, and the fingerprint, repeat count and history stay on
  the run row (`error_fingerprint`, `error_repeat`, `error_history`).
  `MAX_HOPS = 8`, `RESEND_AT = [0,1,3,7,15,25,35,45,55]`,
  57-minute window. Rules come from Orchestra config via the `decide`
  environment, never from a `rules.json`. Minimal five-field cron parser
  lives here too (tick needs it). Sweep: a run its worker stopped mentioning
  goes `claimed → unknown` once its lease is out, whether the worker is
  still around or already gone; while the worker stays gone (no heartbeat
  past `workerFreshMinutes`) its unknown runs go back to the queue
  (`unknown → queued`, claim cleared, `not_before` now), so a dead worker
  never blocks a lane forever — a live worker keeps its unknown runs, it may
  still finish them. A run never seen (`seen_at` null) counts as long ago,
  not as just seen. A claimed run whose agent left the rules stops on sweep
  (`agent-gone`); removing a rule stops its claimed and unknown runs too,
  not only the queued ones. The server's startup tick runs this sweep, so a restart
  re-queues dead workers' runs too. Answer: the `card.answered` event
  carries the chosen option in `detail`; answering `Отменить задачу`
  (`CANCEL_OPTION`) cancels the task and starts no new run; answering
  `Принять без проверки` (`ACCEPT_OPTION`) finishes the linked run as done
  with the card's summary — it is not re-queued for another verification
  round. A run told to stop (`cancel_at` set) ends cancelled whatever it
  reports next, even a late "done". Rules are validated before they are
  stored (name, `when`, `to` must name a known agent, `cron` must parse,
  the timezone must exist) — a bad set is rejected with `DecideInputError`
  and the old rules stay. One broken rule stored earlier cannot kill the
  tick: its cron step is isolated, the other rules keep firing, and the
  operator gets one `rules:tick:` notice card about it. The failing-run
  warning fires on the last retry (`attempts === maxAttempts - 1`), never
  on a hardcoded third attempt. Claim/finish tokens are
  `sha256(secret:run:id:issued)`; when no secret is configured the service
  generates a random 32-byte secret per process, so tokens issued before a
  restart stop verifying and the run is re-claimed by lease expiry.
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
    count and the fingerprint. The count (3) is a number in config
    (`orchestra.autoloop.failureRepeatStop`, default 3), not a hardcoded
    constant. The same stop-word also guards the check-fix loop:
    `applyReceipt` stops a run whose check fails the same way that many
    times, before the 5-round cap (see `kernel/decide.ts` above). The fingerprint and the history stay on the
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
    work, and guessing from the text would misfire. The declaration is
    built in `orchestra.ts` `report()` (`failingTestOf`): a test command
    that failed (non-zero exit, timeout, kill, or failure markers in its
    output) before the worker's first file edit, with at least one edit
    after it — that is the fix. The test file comes from the command or a
    FAIL line in the output; when no file can be pinned down the run still
    declares the fix, so the gate asks for the test on the next round. The
    proof rides in the prepared task marker (`reportFixTask`,
    `reportFailingTest`) and the project ledger (`fixTask`, `failingTest`),
    so a crash after preparation still ends the run with what it proved.
  - `kernel/decide.ts` `retryLater` writes exactly one lesson on the second
    failed receipt (idea #11) into the `lessons` collection (`run`, `rule`,
    `text`, `error`, `fingerprint`, `attempts`): attempts only grow, so
    `attempts === 2` fires once per run. The journal is the durable shared
    memory the society reads through `getView` — the three-level memory of
    Б17 exists for L2 (project) and L1 (society) as files
    (`packages/core/src/memory/levels.ts`); the L3 session capture and the
    secret scrubber are separate slices, and the kernel is pure, so the
    lesson cannot go to the Memory service from here. The lesson names the
    error, not a verdict about its cause.
  - `kernel/decide.ts` receipts carry `verification` (idea #14), entries
    `{ kind, detail }` with kind one of `VERIFICATION_KINDS` (`test`,
    `command`, `manual`, `review`, `transcript`). A done receipt that
    declares verification must carry at least two entries of different
    kinds, or it counts a verification round instead; declared methods are
    recorded on the run row (`verification`) and pass through
    `receiptForReport`. A receipt that declares nothing is exempt by
    design: legacy receipts and read-only work have no second method to
    declare. Unknown kinds are rejected, so a typo cannot pass as a second
    method. The live wiring fills `verification` from `orchestra.ts`
    `report()` (`verificationOf`): the worker's CHECKS plus the transcript
    evidence — only when both exist and agree (checks ran, none failed,
    the transcript shows a command ran with no edit after it). The first
    entry is `test` when a test command ran, else `command`; the second is
    always `transcript`. Like the fix proof it rides in the prepared task
    marker (`reportVerification`) and the project ledger (`verification`).
  - `kernel/dispute.ts` + `decide` inputs `raiseDispute` / `resolveDispute` /
    `escalateDispute` + the `disputes` collection (idea #18): the dispute
    ladder agent (15 min) → group-leader (30) → council (60) → orchestrator
    (120) → operator, moving up on its own in `sweep` when a level's time
    runs out, carrying both positions. Reaching the operator writes one
    notice card (`dispute:<id>:operator`) and marks the dispute `noted` —
    a record for the operator, never a block and never an approval gate.
    The ladder is re-exported from `src/session/runner/escalate.ts` as
    `DisputeLadder` next to the error ladder: errors climb when retries
    and fallbacks are exhausted, disputes climb when time runs out. It is
    also reachable from prod code, not only tests: `AutoloopCards`
    `raiseDispute` / `resolveDispute` / `escalateDispute`, the server
    endpoints `POST /api/autoloop/disputes` (+ `/:id/resolve`,
    `/:id/escalate`), and `deadlines()` in `kernel/due.ts` wakes the clock
    on every open dispute, so the tick's `sweepDisputes` climbs it.
- **Coordination attention (Agora MCP 0.8.4–0.8.6 patterns, news run 7, Б8/Б14)**:
  `kernel/attention.ts` is pure reads over the journal — no new tables, no
  foreign code, no MCP client. A thread is the (rule, lane) pair the kernel
  already uses. (a) Stop-хук: `pendingReplies` lists the open ask-cards in
  a run's thread that the run did not ask itself; `finish` refuses a
  worker's own `cancelled` / `nothing` receipt while any are open
  (`DecideConflictError` naming the cards — nothing is committed, the run
  stays claimed, and the sweep later re-queues it to another worker, so
  the thread is never dropped); `done` passes, `failed` retries through
  `retryLater`, an operator cancel (`cancel_at`) bypasses the guard, and a
  check failure never blocks the stop forever (fail-open, as in Agora: the
  stop is allowed and a `run:<id>:stopcheck-failed` notice card is written
  into the journal). The `stopCheck` decide input answers whether a worker
  may stop, checking at most 5 open threads and reporting `threadsChecked`
  / `threadsTotal` / `truncated`. (b) Thread-aware replies: a receipt may
  `resolve` only cards of its own thread (rule + lane) or its own
  (`run_id`); anything else is rejected with "карточка не в треде этого
  раунда" and stays open. `answer` rejects an explicit `thread` that does
  not match the card's thread; answers without a thread work as before.
  Receipt ask/notice cards were already keyed
  `thread:<rule>:<lane>:<name>`. (c) Missed-attention replay: the `replay`
  decide input returns what arrived while a worker was away — routed
  events whose run is not finished, and open ask-cards in threads the
  worker's rules serve — since its last `seen`, floored at 24 hours,
  chronological, capped at 50, with `droppedOlderThan24h` counting what
  fell off the window. Both new inputs are reads: they commit no facts.
  Tests: `packages/core/test/autoloop/attention.test.ts` — 9 tests.
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
  `workerFreshMinutes` (2), `offlineAfterMinutes` (10), plus router
  batching `batchWindowMs` (1000) and `maxBatchEvents` (50).
- **Autonomy modes (news run5, DeepSeek super-agent — ideas only, no
  prototype code; `packages/core/src/autoloop/kernel/autonomy.ts`)**:
  the Society's router runs in one of `off` / `observe` / `auto`, set by
  the operator as `orchestra.society.autonomy` and resolved by
  `autonomyFromConfig` in `src/autoloop/orchestrator.ts`. `off` takes
  nothing — events are still recorded in the journal, but nothing is
  routed, no run is queued, no worker claims, and no human is notified.
  `observe` (the default when a config is present) prepares but does not
  execute: events route and queue runs as proposals, `claimNext` hands
  nothing out, and flipping the mode to `auto` claims the queued
  proposals — no work is lost. `auto` executes as before. The kernel
  default when no mode is given is `auto` (legacy behaviour, so existing
  callers and tests keep working); the service default is `auto` until a
  config is present, when `ensureConfigured` applies the operator's mode.
  A live autonomous society must set `auto` explicitly — that is the gate.
  In `observe`/`off`, `createRun` returns null (the task is not sent to
  the worker session), and dispatch fails with a `DispatchError` naming
  the mode as a possible cause. `claimDueRun` likewise claims nothing
  until the mode allows it.
- **Silence rule** ("speak only when the human must act or can use a
  result", same source): every notice the kernel creates declares why the
  human needs it (`NotifyKind`: `action` — something needs doing;
  `result` — a finished outcome the human can use). There is no third
  kind — a notice that is neither must not be created. Ingest itself
  never notifies: N events in, zero cards out. In `off` mode every notice
  is dropped at the `notify` gate. Worker-initiated cards from receipts
  pass through untouched — they are the worker's own messages, not the
  router's.
- **Router batching** (same source): `decide` input `ingestBatch` records
  a whole burst from one source in a single pass (one commit, one
  deadlines recompute), deduping inside the batch and against the journal
  (same `(source, key)` twice is recorded once), and coalescing
  same-rule, same-lane events into one queued run through `enqueue`.
  One call is capped at `MAX_BATCH_EVENTS` (200) — split bigger bursts.
  The service accumulates single events per source
  (`Autoloop.ingestEvent`) and flushes them in one `ingestBatch` pass
  when the window (`batchWindowMs`) runs out or `maxBatchEvents` arrive
  (`shouldFlushBatch` in `kernel/autonomy.ts` is the pure predicate the
  service and the tests share); `flushBatch` forces the flush, and
  `start()` forks the window loop next to the clock loop. An event is not
  in the journal until its batch flushes. `Autoloop.configure` accepts
  `autonomy` and `batch`; `AutoloopCards` carries the mode through
  (`CardsEnv.autonomy`). Tests:
  `packages/core/test/autoloop/autonomy.test.ts` — modes, silence,
  batching, config resolution, service batching.
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

## Prompt intake — `packages/core/src/prompt-intake/`

Built-in, automatic deep processing of every incoming user prompt, so agents
receive a structured task instead of a raw one-liner. Runs in
`SessionPrompt.prepare` (`packages/core/src/session/prompt.ts`) after the
`session.prompt` plugin hook, before the prompt is admitted to the inbox.
An intake failure never blocks admission: it falls back to the raw prompt (a
warning is logged). No verdict blocks admission either — see the policy
below. Trivial prompts — greetings, thanks, short acknowledgements
("отлично", "привет", "спасибо", "ок") and continuations ("продолжай", "да")
— skip analysis entirely (`normalize.ts:isTrivial`, purely lexical, no model
call): they are not tasks, so no value check, no model disambiguation and
no skill lookup runs for them.

- **Value check first** (`value.ts`, pure): duplicate → `merge`, already
  done → `skip`, too vague → `clarify` (1–3 questions), clear → `execute`.
  Compares against DoD items (open and done), recent user prompts in the
  session, and autoloop journal titles (cards and runs). Every verdict
  carries its evidence (kind, ref, title, similarity score); a source that
  was not consulted is reported in `sources`, never silently treated as
  "no match". A failed journal entry is a retry, not a duplicate: it
  executes, with the earlier failure named so the agent investigates it
  first. Runs before any deep processing so tokens are never spent on
  work that already exists.
- **Value policy as code** (`policy.ts`, pure): the pipeline returns a
  `disposition` with every result — always `admit`, with an advisory
  reason for anything but `execute`. The intake never refuses a prompt:
  a `clarify` verdict admits with its questions in the reason, so the
  model asks the user in chat instead of the sender getting a "Prompt
  rejected" box; `skip`/`merge` admit with the reason, so the model
  verifies the "already done / duplicate" claim and tells the user
  instead of the prompt being dropped unseen. This used to refuse
  (`refuse` + `PromptInput.Rejected` → `PromptRejectedError` on HTTP),
  gated on human origin and a 3-keyword minimum — both gates are gone
  with the refusal. `PromptInput.Rejected` still exists as the channel
  the `session.prompt` plugin hook uses to refuse a prompt; the intake
  no longer raises it. Caveat: the
  session-history `succeeded` branch can never fire in production —
  `prepare` feeds recent prompts without an outcome, so a repeated prompt
  that already succeeded is only ever `merge`, never `skip`.
- **The intake actually runs** (`session/prompt.ts`, `runPromptIntake`): it
  used to die on every prompt — `Effect.option` wraps each source in an
  `Option`, but the code read the `Option` as the value (`.filter` on it
  threw, `.type` never read `"ready"`, the journal view got the `Option`
  itself), so the outer catch fell back to the raw prompt and no verdict
  was ever computed. The three gathers now unwrap with `Option.isSome`
  before reading. A source that fails still reports as not consulted.
- **Understand** (`understand.ts`, pure heuristics, no model): goal (first
  sentence), context (other sentences + mentioned files/links), constraints
  (sentences with "не", "только", "без", "only", limits), DoD criteria
  (goal + verification + no regressions), ambiguities (vague words and
  missing targets become questions with a default assumption, at most 3),
  plan (verb-class template: fix/build/research/question/review/test),
  keywords. `needsModel` is true when the reading is too uncertain to trust.
- **Model disambiguation** (`model.ts`): only when `needsModel` and the
  verdict is `execute` or `clarify`. One short JSON call to a cheap model
  only — `lix/deepseek-v4.1-flash`, fallback `anymodel/gemini-3.8-flash`
  (`CHEAP_MODEL_PREFERENCE`); when neither resolves, the step is skipped
  and the heuristic reading stands. Never the session's model and never an
  expensive model. Any failure (no cheap model, no credentials, timeout
  30 s, unparsable output) falls back to the heuristic assumptions. The
  model's word is bounded in code, not trusted as text: a `clarifiedGoal`
  replaces the user's goal only when non-empty and at most 500 characters,
  otherwise the heuristic goal stands; assumptions are truncated to 500
  characters each.
- **Skills** (`skills.ts`): the module does NOT replace skills. Skills are
  for executing the task; the module only recommends which ones to load,
  by keyword overlap against name, description and the head of the skill
  content (Russian task words map to English skill words via
  `DOMAIN_ALIASES`), top 3 with a reason. The agent loads them itself.
- **Service** (`service.ts`): `PromptIntake.Service.process` wires value →
  understand → model → skills into a structured result (`IntakeResult`:
  value verdict, structured task, recommended skills, `trivial` flag,
  `modelUsed`). The pure pipeline (`processPure`) is the same without a
  model or services. There is no enriched prompt text: the structured
  interpretation is data, not message text. Registered as a location node in
  `packages/core/src/instance.ts`, so it is available in the session scope.
- **Integration**: the stored user message text is always the original
  prompt — no structured block ever enters it. A compact intake summary
  (verdict, goal, questions, skill ids, modelUsed, trivial, plus the
  structured task itself: DoD, plan, constraints, ambiguities — capped at
  5/5/3/3) is attached to the message metadata under `intake`. The model sees the analysis only as
  a short internal note built from that metadata in
  `session/runner/to-llm-message.ts` (`intakeNoteText`, in the style of
  `roomContextText`): the distilled goal (only when it differs from the
  message), the DoD criteria ("Done when: …") and the plan ("Plan: 1. …")
  — with lines that merely restate the goal ("<goal> — выполнено") and the
  continuation placeholder dropped — constraints, a verdict line only for `skip`/`merge`/`clarify`, open
  questions, ambiguities with their default assumption, suggested skills. The note is omitted for trivial prompts,
  when there is no intake metadata, and when it adds nothing beyond the
  message itself — so a simple single-sentence task costs the model 0
  extra tokens, and a task that does get a note costs roughly ~100 tokens
  for a full task with DoD and plan (vs ~150–200 for the old enriched prompt); a clarify with questions costs less.
  A trivial prompt gets a different note instead of the analysis: a greeting
  or acknowledgement is not a task, so the note tells the model to answer
  briefly, in one short sentence, in the user's language, with no
  follow-up questions or task list. A trivial continuation ("продолжай",
  "да") resumes the work in progress and gets no note at all, so the
  brevity instruction cannot cut the resumed reply short. The same
  one-sentence rule for greetings also lives in the default system prompt
  (`session/runner/prompt/system.txt`, Communication), so it applies on
  paths without intake metadata too.
- Tests: `packages/core/test/prompt-intake/` — value (duplicate, subset,
  done, repeat, failed journal entry retries instead of merging, vague, clear,
  continuation), policy (admit-always matrix, clarify questions in the
  advisory reason, the reported vague prompts admit), understand (goal/context/constraints/ambiguities/
  plan/needsModel), skills (alias matching, top-3), service (mock
  disambiguator, no model, continuation passthrough, trivial prompts skip
  analysis, no enriched prompt field, never fails, disposition on the
  pipeline result, overlong clarified goal ignored), normalize (trivial
  detection: greetings/thanks/acknowledgements true, real tasks false).
  Enforcement at the session level: `packages/core/test/session-prompt.test.ts`
  — a vague user prompt is admitted and wakes, carrying its questions in
  the intake metadata; a clear user prompt is admitted and wakes; stored
  text is the original prompt (trivial and non-trivial),
  intake metadata present. HTTP level:
  `packages/server/test/session-prompt-held.test.ts` — a vague human prompt
  posted over HTTP is admitted (200) with a clarify verdict and questions
  in the intake metadata, not rejected.
  `test/session-runner-message.test.ts` — the model message carries the
  short intake note (goal/skills/questions/verdict, plus DoD/plan/
  constraints/ambiguities when they add signal), the stored text does
  not; a brief-reply note for trivial greetings, no note for trivial
  continuations, for prompts where the note adds nothing, or without
  intake metadata. `test/session-system-prompt.test.ts` — the default
  system prompt answers greetings in one sentence.

## MCP — `packages/core/src/mcp/`

- `catalog.ts` is the curated catalog: a server is catalogued only if it adds a
  capability the native tools lack. Current entries: context7, serena,
  xerj, rea-anything, playwright, chrome-devtools, agent-desktop, github, deepwiki, sentry. Servers
  duplicating native tools (filesystem, git, fetch, memory, sequential-thinking,
  time, generic search) are deliberately absent — do not re-add them; the
  classes live in `catalog.ts` as `nativeAnalogues` instead, and the selector
  answers them with native tools.
- `select.ts` is the smart selector: Russian needs translate to English before
  matching, every candidate carries a confidence score, and below the threshold
  (or on a tie at the top) it returns an ask-card instead of guessing. Fallback
  chains are fixed per server (context7 → deepwiki, serena ↔ xerj → native
  symbols/grep, playwright → agent-desktop, chrome-devtools → playwright → agent-desktop); `mcp_manager acquire` walks the
  chain when the winner is down. Persistent ratings (`ratings.ts`, KV-backed)
  nudge the ranking; every dispatch records its outcome. "browser automation"
  still picks playwright first: chrome-devtools is the Chrome-specific
  alternative, found by name ("chrome devtools"); its description deliberately
  avoids the browser-synonym words (navigate/click/screenshot) that would tie
  it with playwright on that need.
- Browser-MCP recovery (`tool/mcp.ts` + `tool/mcp-recovery.ts`, pure):
  snapshot-driven tools fail on stale references — chrome-devtools
  `click` with a uid from an older snapshot ("Element with uid 2_66 no longer
  exists on the page", "not found on page N"), playwright/agent-desktop stale
  refs (`ref ... not found`, `STALE_REF`, `AMBIGUOUS_TARGET`). The wrapper
  does not retry the dead uid: it takes a fresh snapshot itself (read-only,
  same server, its own permission asserted, denial degrades to a hint) and
  returns it inside the ToolFailure, so the model retries the action with the
  new uid in one turn instead of spending a take_snapshot turn first. A
  snapshot tool failing with a stale error is never "recovered" with another
  snapshot. `evaluate` has no timers: `setTimeout`/`setInterval` inside it
  fails with "Unknown identifier", and the wrapper answers with the server's
  `wait_for` tool instead. The patterns are server-agnostic — snapshot/wait
  tools are discovered by name from what the server offers
  (`take_snapshot` / `browser_snapshot` / `snapshot` / `desktop_snapshot`,
  `wait_for` / `browser_wait_for`). Tests: `test/mcp-recovery.test.ts`
  (pure patterns) and `test/mcp-browser-recovery.test.ts` (through the real
  tool leaf with a fake MCP service: before the fix the stale click returned
  the bare error, after it the failure carries the fresh snapshot).
- chrome-devtools (`catalog.ts`): Google's `chrome-devtools-mcp`
  (`npx -y chrome-devtools-mcp@latest`), tools `take_snapshot`/`click`/`fill`/
  `evaluate`/`wait_for` and more. Its catalog usage carries the two rules the
  live sessions kept tripping on (uids go stale — always use the LATEST
  snapshot; no timers in evaluate — use `wait_for`). It is NOT a real-screen
  server: the default launch spawns its own Chrome instance and does not
  attach to the operator's running browser (attaching with `--browserUrl`
  would drive the operator's browser and belongs outside the opt-in).
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
- `client.ts` negotiates the MCP protocol era (news run7, БРАТЬ №4; SDK
  `@modelcontextprotocol/*` 2.4.0): absent `protocol` in the server config is
  **auto** — the SDK probes the server with `server/discover` for revision
  2026-07-28 and falls back to the plain legacy `initialize` handshake when
  the server answers the probe with Method Not Found or an unrecognized
  result; `"legacy"` skips the probe entirely; `"2026-07-28"` pins the modern
  era and fails the connect loudly otherwise. A modern connection is
  stateless (no `Mcp-Session-Id`, no `initialize`/`notifications/initialized`
  handshake — every request carries the protocol version and client
  capabilities in `_meta`); a legacy one is byte-identical to a 2025 client.
  `Connection` exposes what `server/discover`/`initialize` reported:
  `modern`, `protocolVersion`, `serverVersion` (name/version, undefined when
  a modern server stays anonymous — display label only, never an identity
  proof) and `supportsTasks`. The `mcp connected` log line records the era,
  protocol version and server version. Known costs of auto: a stdio probe
  spawns one short-lived sibling process per connect, and on HTTP a probe
  that times out rejects the connect (silence on a deployed server is an
  outage, not a legacy signal); a 401/403/5xx answer to the probe fails it
  outright too (the SDK treats 5xx as a broken server, never as a legacy
  signal) — only a 4xx or a JSON-RPC Method Not Found falls back to
  initialize. All of that is SDK behavior, not ours.
- `client.ts` passes upstream `--read-only` (servers v2.3.0) to a local
  filesystem server when the server config sets `readOnly: true`
  (`Mcp.LocalConfig`, off by default); any other server ignores the flag with
  a warning, so a stray flag can never break a server's startup. The native
  file tools (`read`/`edit`/`write`) are NOT covered by this flag — they stay
  permission-gated, not hard read-only.
- MCP 2026-07-28, what is NOT migrated yet (next step, not a gap to hide):
  tasks were moved out of the core protocol into the official extension
  `io.modelcontextprotocol/tasks`, but SDK 2.4.0 ships wire schemas for
  `tasks/*` with **no runtime** — its typed method surface explicitly does
  not offer them — so Orchestra does not call tasks at all. `supportsTasks`
  on the connection is only the gate a future tasks-extension caller checks
  (server advertised the `tasks` capability in discover/initialize) before
  speaking the extension; adding real tasks calls needs either an SDK with a
  tasks runtime or a raw transport call, and must stay behind that gate.
  HTTP+SSE transport is Deprecated in the revision and is never used here
  (remote servers go through Streamable HTTP; stdio for local ones).
  Sampling, roots and logging are in the deprecation process (cannot be
  removed before 2027-07-28): the client still declares the `roots`
  capability because some legacy servers refuse to run without one, and the
  `notifications/elicitation/complete` handler stays legacy-only — on a
  modern connection the form settles when the SDK retries the tool call.
  Header mirroring (Б13): on a modern connection the SDK transport sends
  `MCP-Protocol-Version` and `Mcp-Method` on every request POST (`Mcp-Name`
  for the methods that mirror `params.name`/`params.uri`/`params.taskId`,
  plus `Mcp-Param-*` for declared tool params), so a gateway can filter by
  method/name/version without parsing the JSON-RPC body; our
  `loggedFetch`/`Ssrf.fetchPublic` chain passes those headers through
  untouched. Legacy traffic carries only the 2025 `MCP-Protocol-Version`
  header — no `Mcp-Method`/`Mcp-Name`. Old revisions keep working for at
  least 12 months from the revision date, so the legacy fallback is not on
  a deadline. Caveat, stated plainly: Claude API, OpenAI Responses API and
  Gemini API had not confirmed support for the new revision as of October
  2026 — a provider-backed MCP endpoint that only speaks 2025 stays on the
  legacy path by auto-detection, not by configuration.
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
- `acquire.ts`: a server is _healthy_ only when connected **and** its tools were
  discovered. `ensure()` = reuse healthy → connect installed → validate
  platform/missing-env/runtime → add+connect+verify. Missing credentials stop at
  `needs_auth` before any install; disabled servers are never re-enabled; failed
  ones are never silently retried.
- MCP servers are off by default, by design (arch3 №9, not a bug): the one-time
  migration (`mcp/lifecycle.ts`, `migrateDefaultOff`, marker
  `mcp/migration/default-off/v1`) persistently disables every enabled server
  in the global config, `ensure()` never re-enables a disabled server, and
  `createSociety` never enables any — the operator enables servers with
  `mcp_manager enable`. A society therefore starts with MCP off unless the
  operator turned servers on first.
- Serena is a session-REPL server, not flat tools: `initial_instructions` →
  session id → `activate_project` → `serena_repl` against the `cfg/fs/edit/mem/
shell/lsp` facades. Its catalog entry runs via `uvx` (`--context desktop-app`);
  `uvx` must be on PATH.
- agent-desktop drives real apps through the OS accessibility tree; GTK3 apps
  without atk-bridge may be invisible to it — that is an app limitation, not a
  server failure.
- agent-desktop 1.2.0 live-verified (pilot 2026-11-07, news run9 №2): the
  catalog command `npx -y agent-desktop mcp` serves the MCP server (handshake,
  67 `desktop_*` tools, `tools/call` works); the snapshot → type → click →
  re-snapshot loop works on GTK3/GTK4 apps under Xvfb `:99` + openbox
  (at-spi2-core required on Linux). The virtual display MUST run a window
  manager: on bare Xvfb snapshots refuse with `native_window_unproven`, and
  twm is not enough (`frames_unanswered`). Done (2026-11-07, b7-window-manager):
  `ensureVirtualDisplay` (`desktop-isolation.ts`) now starts openbox on the
  display (`DISPLAY=<display>`) right after Xvfb, tracks its process, and
  stops it in `stopVirtualDisplay`; without openbox it fails loudly (install
  openbox) instead of silently leaving a bare Xvfb. A window manager already
  running on the display (started by hand) counts as ready. B13: snapshots,
  screenshots and the clipboard can hold private screen data — never paste
  them into public logs or shared chats (noted in the catalog `usage`).
- Client identity is Orchestra, not OpenCode: `client.ts` sends
  `clientInfo.name: "orchestra"` and sets `BUN_BE_BUN` when the spawned
  command is `orchestra`; `oauth.ts` sends the same `clientInfo.name` (its
  `CLIENT_METADATA_URL`/`client_name`/`client_uri` still point at
  opencode.ai — undecided, audit §5.4). Shell/hub tools set
  `AI_AGENT=orchestra` (the `OPENCODE=1` compat marker is kept); `webfetch`
  retries Cloudflare challenges with UA `orchestra`; provider plugins
  identify as Orchestra (`originator` in `openai.ts`, `referrer` in
  `xai.ts`, `X-Cerebras-3rd-Party-Integration` in `cerebras.ts`). The
  `ai.opencode/*` idempotency/session keys in `client.ts` are untouched.
- B7 (desktop isolation): agent-desktop and playwright are `realScreen` servers.
  They are never acquired (`acquire.ts: ensure()`) nor called (`index.ts:
MCP.callTool`, the choke point for every MCP tool call) while the real-screen
  opt-in is invalid — even when installed by hand in the config. The selector
  (`select.ts`) still matches them; the gate lives in acquire/call, not in ranking.

## Code search (xerj) — `packages/core/src/mcp/catalog.ts`, `packages/core/src/memory/code-search.ts` (Б17, pilot run6)

- The search layer under the three-level memory is xerj v1.0.0-rc.101 (news
  run6 №5), chosen over Graphify v0.9.102 (№2) on a pilot of the same six
  agent questions over `packages/core/src` (688 files, both tools indexed the
  same corpus; full-repo indexing was abandoned mid-pilot — see below).
  Scores (2 = file + symbol, 1 = file only, 0 = wrong): tie 8/24 each
  (graphify EN 5/12, RU 3/12; xerj EN 4/12, RU 4/12). Tie-breakers for xerj:
  ~35% fewer answer tokens (8 693 vs 13 345 chars/4 over 24 answers),
  ~5x faster to index (4m38s vs ~23 min for the same 688 files),
  ~5x faster per query (~2–3.5 s vs ~15 s), deterministic output size
  (`-k`/`--full`), and Russian questions return ranked passages instead of
  an empty hard fail (graphify `query` exits 4 with "No matching nodes
  found" on 3 of 6 Russian questions — it matches code keywords only).
  Honest limit: neither beats a grep from an agent that already knows the
  symbol name (the six perfect greps cost 324 tokens total); the tools pay
  off only when the agent does NOT know the name — and there they score
  33%, so xerj is a first try with a fallback chain, not an oracle.
- Graphify's failure modes, for the record: `query --budget 2000` returned
  ~6 600 tokens anyway (the budget flag is not honoured — edges are never
  dropped once every node fits), the full-repo extract ran ~30 min to 80%
  (5 700/7 048 files) before a runtime restart killed it, and the rerun
  reused only 562 cached files, so it does not resume after a kill.
  The full-repo xerj autoindex also never finished in the pilot (82.9% of
  91.7 MB when the runtime restart killed it; the resume then stalled on
  edge invalidation) — the full-repo numbers above are scoped-corpus
  numbers, and a full-repo re-index is a documented follow-up, not a
  claim made here.
- Wiring (minimal, off by default like every catalog server): the catalog
  entry `xerj` runs `xerj mcp --url http://127.0.0.1:9200
--disable-feedback` (stdio) against a node the OPERATOR starts first:
  `xerj --data-dir ~/xerj-data` (auth on by default — export
  `XERJ_API_KEY` from `<data_dir>/admin.key`), then `xerj autoindex
<project>` once. Orchestra never starts, stops, or restarts the node,
  and never passes `--insecure`: that flag is a local-sandbox flag only
  (the pilot used it on 127.0.0.1:9217 because the sandbox node had no
  key yet) — in production a node without auth is a refusal, not a
  fallback. `MemoryCodeSearch` (`memory/code-search.ts`) holds the seam:
  `DEFAULT_NODE_URL`, `nodeUrlFromEnv` (`XERJ_URL`), `mcpCommand`, and
  `loopbackProblem` (refuses any non-loopback node URL, fail-closed).
- Fallbacks: `xerj` → `serena` → native symbols/grep; `serena` →
  `xerj` → native. A generic "поиск по коду" still ranks serena first
  (xerj needs a running node; serena needs only uvx) — xerj wins only
  when the need names it (`xerj`, `indexed search`).
- Roles: `xerj_*` rides with `serena_*` in the MCP Servers group, the
  `read` implied tools, and the role-toolkit `MCP` const
  (`packages/schema/src/orchestra.ts`) — that is what makes at least one
  team role allowed to use it (the role-profiles test enforces this for
  every catalog server, and two of its exact-list expectations name
  xerj next to serena).
- Fragility, stated plainly: the pilot node died 5 times in ~3 hours on
  this 8 GB shared VM (no crash line in its log; each death coincided
  with <200 MB free memory, so OOM-kill is the likely cause, unproven —
  `dmesg` is not permitted here). The node recovers its index from WAL
  on restart (9 297 / 18 736 entries replayed) and autoindex resumes
  from its journal, but a society must treat xerj as optional: acquire
  with the normal MCP timeout and circuit breaker, and let the fallback
  chain serve when the node is down. Do not add a watchdog or auto-restart
  for the node until someone owns running it.
- Tests: `packages/core/test/memory-code-search.test.ts` (4: default URL,
  env override, MCP command incl. no `--insecure`, loopback guard),
  `mcp-catalog.test.ts` (xerj entry), `mcp-select.test.ts` (both fallback
  chains), `mcp-role-profiles.test.ts` (xerj in the derived profiles).
  Verify: `bun test test/memory-code-search.test.ts
test/mcp-catalog.test.ts test/mcp-select.test.ts
test/mcp-role-profiles.test.ts` in `packages/core` (31 pass).

## SSRF gate — `packages/core/src/tool/ssrf.ts` (Б13, extended in G2-2)

- One shared gate for every outgoing URL: `Ssrf.assertPublicUrl` (Effect),
  `assertPublicUrlPromise` (plain async), `assertPublicLiteralUrl` (sync, no DNS).
  It refuses non-http(s) URLs, local hostnames (`localhost`, `*.localhost`,
  `*.local`), literal private/loopback IPs, and hostnames that resolve to a
  private address. DNS failure fails closed. Deliberately not blocked:
  198.18.0.0/15 (benchmarking space — the sandbox resolver answers public names
  from it) and the TEST-NET documentation ranges. IPv6 literals with an
  IPv4 tail are judged on the tail in both spellings: dotted (`::ffff:127.0.0.1`)
  and hex (`::ffff:7f00:1`, `::7f00:1`, `::ffff:a9fe:a9fe` = 169.254.169.254) —
  but only under an IPv4-embedding prefix (`::ffff:0:0/96`, `::/96`,
  `64:ff9b::/96` NAT64); a public address whose tail merely looks like a
  private IPv4 (`2606:4700:4700::1111`) stays public. `100::/64` (discard) is
  refused as well.
- Redirects are followed by hand through one shared helper, `Ssrf.fetchPublic`
  (gate on every hop, `redirect: "manual"`, max 5 hops, one timeout deadline
  for the whole chain): credentials never follow a redirect to another origin,
  and a request with a body is never re-sent to one. New outgoing fetches use
  it; do not invent another redirect loop. Residual risk, stated plainly:
  the gate checks the name immediately before the connect, so a resolver that
  answers differently at connect time (DNS-rebinding TOCTOU) is not closed —
  closing it needs connecting to the pinned IP with TLS verified by name,
  which plain fetch cannot do. Literal IPs have no such window.
- Guarded call sites: `webfetch` (every URL and every redirect hop), remote MCP
  connect (`mcp/client.ts` — the checked URL is the one the transport dials),
  provider discovery (`provider-discovery.ts` — `Ssrf.fetchPublic`, so the gate
  runs on the base URL and on every redirect hop before the API key is attached
  to any header), MCP Forge validation + `fromOpenApi` (literal
  check) and the generated runtime (its own embedded copy of the gate, because
  generated code cannot import Orchestra modules; redirects followed by hand,
  one hop at a time), Code Mode fetch (`codemode/web.ts`, manual redirects),
  MCP OAuth discovery/token fetches (`mcp/oauth.ts` — `gatedSend` is
  `Ssrf.fetchPublic`, so a 307/308 never re-sends a token-exchange body to
  another origin), and `mcp_forge` remote registration (`tool/plugin/mcp-forge.ts`).
- `allowPrivateUrl` is a test-only escape hatch for loopback fixture servers
  (`mcp/index.ts` layer options → pool → client → oauth). Production callers
  never pass it; a remote MCP server on a private or loopback address is refused
  unless the caller explicitly opts in.
- Upstream fetch `--allowed-hosts` (servers v2.3.0) has NO equivalent here, by
  design, not by oversight: this gate is a denylist (any public host may be
  fetched unless it resolves private), while upstream's is a positive allowlist
  (only named hosts may be fetched). The gate is strictly stronger against
  SSRF — per-hop DNS checks, credential stripping, body-refusal on cross-origin
  redirects — but an operator cannot restrict fetching to a named set of public
  hosts. Adding that allowlist is a separate, unplanned change.
- `webfetch` timeouts follow the upstream fetch window (servers v2.3.0):
  per-call `timeout_ms`, legacy per-call `timeout` in seconds, `FETCH_TIMEOUT_MS`
  env default, 30 s default, everything clamped into 100–600_000 ms
  (`resolveFetchTimeoutMs`).
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
  MCP `agent-desktop`/
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
- The virtual display runs a window manager (openbox, pilot-verified): `ensureVirtualDisplay` starts it with `DISPLAY=<display>` right after Xvfb, tracks the process, and `stopVirtualDisplay` stops it first, then Xvfb. A bare Xvfb is never reported ready. Without openbox the call fails loudly ("Install openbox", `native_window_unproven` named); a manager already running on the display counts as ready (the status reports it as `windowManagerForeign`, with no pid of ours — openbox prints that message on stdout, not stderr). The `started` journal event records the manager pid too.
- Virtual-display state is a journal fact (`journal.ts`: `recordDisplayEvent`,
  type `desktop.display`, states `started`/`alive`/`died`): which display, whose
  session, and a death is an event, never silence.
- Opens are deduplicated (block Б4, `tool/idempotency.ts`): `desktop_open`
  opens a URL once per session, even across re-entry.
- `playtest launch` (arch3 №6) can only start the game under test: the path
  must stay inside the project, a bare program name must be a known launcher
  (`powershell`/`pwsh`/`electron`/`chrome`/`chromium`/`msedge`/`brave`/`nw`/
  `npm`/`pnpm`/`yarn`/`npx`), and `.bat`/`.cmd` files are refused outright
  (run scripts through `powershell.exe -File` instead, no `shell: true`).
  The Chromium DevTools port binds `127.0.0.1` and allows origins from
  loopback only — the old `--remote-allow-origins=*` is gone.
- Regression tests that must run on every commit touching `desktop*` /
  `shell` / `playtest`: `test/tool/desktop-virtual-display.test.ts`
  (a secret window on the host display is invisible on the agent screenshot;
  a link opens once across three calls and not again after re-entry),
  `test/tool/desktop-isolation.test.ts` (gate decisions, shell escapes, MCP
  acquire refusal) and `test/tool-playtest.test.ts` (launch
  paths inside the project, batch files refused, DevTools loopback-only). A new screen-access path (new tool, new MCP server) must
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
- `group_status` also reports the Society's live agents society-wide
  (`packages/core/src/society-status.ts`): per-project and total counts of
  running (executing live in this process — never a durable claim, which
  survives a crash and would read a dead turn as running), claimed (holds
  a durable execution claim but is not executing — a turn that never
  completed), waiting (a delivered task nobody started — never read as
  working), succeeded, failed and interrupted sessions, plus `live` (did
  not die). Counts only, never session IDs, titles or names; when the claim
  store is unavailable in the layer the output says `claimsAvailable: false`
  instead of reporting zero running.
- A federation group is **not** the society_forge "Society" feature; do not
  conflate them.

### The Society feature (`society_forge`) — `packages/core/src/society.ts`, `federation.ts`

A Society is founded from a goal (`society_forge found` → `Federation.createSociety`):
a planner project plus an optional team project. The planner plans in its first
messages and builds the rest with `society_forge generate` and `society_plan`.

- Base projects come from the operator's `orchestra.society.baseProjects` config
  when it is set and complete, otherwise the built-in four (planner, architects,
  coders, testers). A configured entry missing a field falls back to the built-ins.
- Autonomy mode: `orchestra.society.autonomy` (`off` / `observe` / `auto`,
  default `observe` when a config is present) says how much work the
  Society's router (the autoloop, see "Autoloop journal") may take on its
  own. A live autonomous society must set `auto` explicitly; in
  `observe` work piles up as queued proposals and dispatch is refused,
  in `off` nothing is even queued. The kernel and the service default to
  `auto` without a config, so existing callers keep working.
- A project created from a built-in team template opens one worker per template
  role at once — in `createSociety` for the team project and in `generate` for
  base and extra projects — never zero workers. Operator-saved templates open
  their saved roster at creation instead.
- Before anything is created, `createSociety` runs the provider preflight
  (`SocietyPreflight.checkLive`, `packages/core/src/society-preflight.ts`):
  an Anymodel key must be stored (credential store first, provider settings
  second) and alive (`GET /models`), and the planner's model must be served.
  A failed preflight refuses the creation with the fix named; without
  the Provider service in the layer the check is skipped when a key is
  stored — the endpoint cannot be determined from the Credential
  service alone, and the Federation context does not provide Provider,
  so a stored key must not be reported as unconfigured. With no key
  stored the check still fails with "No Anymodel API key": a missing
  key is definitive evidence, not a missing endpoint, and the G2-1
  gates (refuse creation, stay quiet on resume) must not open just
  because Provider is absent.
  The same preflight runs at server boot (logged, never
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
- Model table (`society.ts`, verified against Anymodel 2026-11-06,
  re-verified twice on 2026-11-07 (run6 + run7), still 17 models in the same
  order — then re-verified again the same day (run10): the listing shrank to
  14 models, `anymodel-coder`, `anymodel-reasoner` and `anymodel-v4.1-flash`
  left `/models`):
  strong `opus-5.5`, mid `sonnet-5.5`, cheap `anymodel-coder` (quality work),
  fallback `sonnet-5`; cheap flash alternative `gemini-3.8-flash` (also a
  main-session fallback after `anymodel-coder`), reasoning `grok-4.7` next to
  `opus-5.5`. `anymodel-coder` is not in `/models` anymore but still answers
  live chat (run10, 45 tokens), so it stays the cheap tier and a fallback
  while the catalog holds any Anymodel model at all; `anymodel-reasoner` and
  `anymodel-v4.1-flash` are dead in chat too and stay dead. The other new models (`gemini-3.5-flash-lite`, `gemini-3.6-flash`,
  `gemini-4-argon`) are catalogued in `ANYMODEL_MODEL_IDS` but have no assigned
  role yet. Checked 2026-11-07 and absent at Anymodel, so not catalogued:
  `gpt-6.1-terra` (cheap worker / computer-use candidate), `mistral-large-4`
  (open-weight coder), `ripple-65b` (cheap open coder), `deepseek-v4.1-flash-1017`
  (cheapest popular open worker, 24.8% of OpenRouter tokens), `deepseek-v4.1-flash`,
  `glm-5.3-flash` (output price down 81.5%); the absence test in
  `society.test.ts` fails loudly when one arrives. Terra, when it arrives, is
  a worker candidate only with monitoring outside the agent itself (Б13: Terra
  agents fell into destructive-action scenarios more often in OpenAI's own
  tests). Dead models (`anymodel-reasoner`, `anymodel-v4.1-flash`, `fable-5.1`,
  `gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol`) are never a primary or a fallback;
  `workerModels` also gives cheap work the cheap model instead of the
  Orchestrator's flagship. Building the Society (`society_forge found/generate`,
  `society_plan apply`) is exempt from the 6-message rule and resets its count;
  the MCP survey (`mcp_manager inspect`) is exempt too — a dispatch is refused
  without a fresh survey, so blocking the survey at the limit would deadlock
  the Orchestrator (it could neither survey nor dispatch); acquiring or
  installing a server stays gated. The refusal text names the survey and the
  explicit `mcp` assignment as the way out.
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
- **Project session listing is scoped, not a full scan**: `Orchestra.projectSessions`
  (`packages/core/src/orchestra.ts`) reads only the sessions in the project's own
  directory tree via `SessionStore.list({ directoryPrefix })`
  (`packages/core/src/session/store.ts`, `session_v2_directory_idx`, migration
  `20261107101054_busy_orphan`), plus the sessions explicitly claimed to the
  project from elsewhere; the ownership filter (claims, nested projects, group
  chats) still decides each candidate. The old full top-level scan made one
  listing take ~1s at ~2000 sessions and `group.status` ~3–6s; both are now
  ~15ms / ~60ms at the same size. The orphan-main repair in `ensureMain` still
  uses the full `topLevelSessions` scan — it is rare and needs sessions from
  anywhere.
- **Chat**: `session.prompt` returns `{data, held}` — `held: true` means the
  prompt was admitted but the session is paused (hold), so the client shows
  "Session is paused" instead of silence. The composer retries a failed send
  up to 3 times with backoff (0/500/1500 ms) reusing the same admission id,
  so the server's idempotent reconcile never duplicates the message.
  A stream interrupted after the first tokens publishes a failed receipt
  with the partial output and continues in a new round. Resume-on-start
  resumes by its own rules in `packages/core/src/session/execution/restart.ts` —
  it does NOT ask the autoloop journal: `Journal.hasUnfinishedRun` exists
  and answers, but nothing calls it today (arch3 №23), and `readErrors`
  has no reader outside tests.
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
  A backup is a **pair — database + credential key** (arch3 A3-01): the
  key file is copied next to the backup as `<backup>.key` (0600), and a
  backup refuses to be written when the live database holds sealed
  credentials and no usable key is available — a database backup without
  its key cannot decrypt anything after a key loss, and the server will
  not start. Legacy OAuth tokens in `account`/`control_account` are sealed
  with the same key by migration `20261106120000_seal_legacy_account_tokens`
  (arch3 A3-04); a database copied from upstream opencode carries them
  sealed from the first boot. A freshly written backup is verified (magic header +
  `PRAGMA quick_check`) before it counts, and a corrupt one is deleted
  on the spot (A3-02). Durable events persist by default (G2-7: `Bus` keeps payloads unless
  `persist: false` is passed explicitly — a plain `orchestra serve` used to
  drop them on restart). Backups run themselves (G2-8): the Node server takes
  one at startup — before the startup hold resumes Societies — and then one
  every 6 h into `<data>/backups`, keeping the 7 newest (`ServerOptions.backup`
  to tune, `packages/server/src/database-backup.ts`); a file database with
  pending migrations is snapshotted before the migration runs
  (`DatabaseMigration.pendingMigrations`, best-effort, never fails the boot).
  Restore is atomic: the backup is verified (magic header +
  `PRAGMA quick_check`) before the live file is touched, the key is proven
  to open the backup's sealed rows before anything is replaced, the live file and
  its `-wal`/`-shm` sidecars are moved aside to
  `<database>.pre-restore-<timestamp>` instead of deleted, the copy is
  verified again, and a failed copy or verification moves the live database
  back — a corrupt backup can no longer destroy the live database. Rotation
  (`pruneBackups`) deletes pruned backups together with their `.key`
  siblings. The operator entry point is `orchestra db restore <backup>`
  (A3-03; `--force` only when the server is certainly stopped).
  `restoreDatabase` still needs the server stopped: an open connection would
  keep writing to the replaced inode.
- **Memory database (Б17 slice 1, Б18 №36–№41 minimum)**:
  `packages/core/src/memory/db.ts` — `memory.db` lives at
  `<project>/.orchestra/memory.db`
  (`resolveDefaultMemoryDbPath(projectDir)`); the memory tool opens it from
  `Location.project.directory` (`getMemoryEngineForProject`, one cached
  handle per project), so two projects never share one database and a
  moved working directory does not move the memory. A bare
  `MemoryEngine.open()` with no project still falls back to the process
  working directory. `PRAGMA synchronous = FULL` (was `NORMAL`), WAL,
  mmap capped at 64 MB (was 256 MB). The schema is versioned:
  `memory_migrations` table, `CURRENT_MEMORY_SCHEMA_VERSION = 1`,
  `applyMemoryMigrations` — a database created before migrations existed
  upgrades by a no-op DDL pass and then records version 1.
  `backupMemoryDatabase(dbPath, destination)` snapshots via `VACUUM INTO`
  and verifies with `PRAGMA quick_check`; it is NOT wired into the
  server's automatic backup cycle above, which snapshots only the single
  `orchestra-local.db` — per-project wiring is still open. The database
  itself is still `bun:sqlite` outside the Effect/Drizzle infrastructure
  (B18 №36): moving it onto that infrastructure is a separate, larger
  change, not done here.
- **Secret scrubber (Б17 §7 risk 2)**: `packages/core/src/memory/scrub.ts`
  — `scrubText`/`scrubValue` redact private-key blocks, JWT, Bearer,
  `sk-`, GitHub/Slack/AWS tokens, `anymodel-`/`lix-` prefixed keys and
  labelled values (`api_key=`, `password:`, `token:`, …) before any write:
  `MemoryEngine.remember`/`link`, `Memory` blocks/archive (`save` /
  `remember` / `writeArchive`), `Journal.recordError` /
  `recordDisplayEvent` (message + detail). A `<private>` tag is not a
  protection — the scrubber runs on the text itself. The exact Anymodel/lix
  key formats are not published anywhere in the repo, so those keys are
  caught by prefix + label, not by an exact vendor pattern.
  Tests: `packages/core/test/memory-foundation.test.ts` (12: scrubber
  shapes + benign prose, FULL/WAL/version, legacy upgrade, backup copy,
  per-project engines, engine/file/journal gates).
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

## Self index — `packages/core/src/self/`, `packages/core/src/tool/plugin/self.ts`

The self index is how the agent knows Orchestra itself: CLI commands (parsed
from the Spec tree in `packages/cli/src/commands/commands.ts`), config keys
(from `Config.Info` annotations in `packages/schema/src/config.ts`), every
`ORCHESTRA_*` variable (from `env-registry.ts`), built-in tools, extension
points, and this atlas's sections, plus operator files from the
`self_index.paths` config key. Storage is one SQLite database at
`<data>/self/index.db` (trigram FTS + the local hash embedding from
`memory/embed.ts`); symbol-level questions about Orchestra's own code go
through the code graph of the source checkout (`self` tool, `code` action).
Freshness is a fingerprint over the version define and every harvested file's
size and mtime: the boot of each location rebuilds in the background when it
moved (`SelfTool.Plugin` fork), so an update reindexes on the next start.
Invariants: collectors derive from the shipped sources, never a
copy; no source tree (node artifact) or no Bun sqlite means an honest
"unavailable", never a silent empty index.

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
`rules list` result, and prefix-pin reports rule changes as a diff. The
governor also stubs old, bulky tool-call arguments (name and id stay, the
first 200 characters stay as a preview); calls named `dod`/`rules` keep
their arguments, like their results. Measured on a planner-like transcript
of 8 dispatches with 4k briefs: 18_647 → 6_033 estimated tokens (−68%;
the results-only governor reached 11_824).

The densifier (`packages/core/src/session/context-densify.ts`, wired in
`SessionModelRequest.prepare` for primary requests, pilot flag
`ORCHESTRA_CONTEXT_DENSIFY=1`, off by default) is the lossless complement:
where the governor stubs old output away, the densifier keeps every value
and only stops repeating it — repeated JSON arrays in tool results become
keys-once plus rows, repeated string values are factored into a dictionary,
and consecutive identical rows collapse into a run count. The compacted form
expands back to canonically identical JSON; anything that fails the
round-trip check is returned unchanged. It is pure TypeScript, deterministic
per input (so the prompt-cache prefix stays stable), with no network, no
model and no telemetry. It comes from the Headroom pilot (news run 7): the
upstream Python library was measured on offline copies of real tool output
and rejected as a dependency — its log/search paths saved 0% on realistic
timestamped logs or hit a 20 s internal timeout and failed open, at seconds
of latency per call — while its JSON-array path saved 87% losslessly, which
the native port matches at 83% in ~0.2 s. The densifier therefore ports
only the JSON-array shape; logs, code search and prose are left untouched
(they measured 0% for the lossless path upstream too).

A new Society starts with six default rules (`Rules.DEFAULT_SOCIETY_RULES`,
seeded by `createSociety` into an empty society scope only): ask three questions
before coding, write an ADR for big decisions, write a handoff before any stop,
30-minute read-only cold start, riskiest part first, record verified outcomes in
the knowledge map. Seeding is idempotent and never rewrites a Society's own rules.
Two of those rules also live as built-in session instructions
(`core/ask-first`, `core/riskiest-first` in `instructions/builtins.ts`), so a lone
session without a Society hears them too.

## Native skill marketplace — `packages/core/src/skill-marketplace/`

The in-Orchestra counterpart to the upstream catalog in the same folder
(`index.ts`: skillsmp.com MCP search, cached rows, SKILL.md fetched from
GitHub, SkillSpector-style scan). The catalog answers "what exists out
there"; the native marketplace answers "what is installed here, at which
level, and how do the pieces fit into a working factory". It never reaches
the network.

- **Manifest (`manifest.ts`)**: a native skill carries a manifest in the YAML
  frontmatter of its SKILL.md — `name`, `version` (semver), `purpose`,
  `inputs`/`outputs` (named ports `name:type`, types `text | json | list |
file | code | plan | report`), `depends` (`name@range`, ranges `^ ~ >= <=
  > <`, exact, `\*`), `rules`. There is no YAML parser in core, so the
frontmatter is read by a strict line parser; a broken manifest refuses the
install instead of guessing. A skill without a manifest gets a derived one
(`version 0.0.0`, no ports, `derived: true`): it can run alone, never
  > chained, because its inputs and outputs are unknown.
- **Three levels (`levels.ts`)**: `society > project > session`. A society
  skill is visible everywhere below it; a project skill to its project and
  its sessions; a session skill only to its session. Lower levels inherit the
  ones above and shadow them by name. Storage is one JSON file per level
  (`<root>/native-skills/skills.json`) plus an append-only journal
  (`journal.jsonl`): every mismatch resolution, install and use is one
  human-readable line with its reason. A damaged registry reads as an empty
  level but says so (`loadLevelDetailed` returns `degraded + damage`, logged
  with the file path), and installing or uninstalling over it is refused —
  the old code saved an empty registry over the damage (arch3 A3-09).
  Installs and uninstalls at one level serialize under a Flock, and the
  skill text itself is written atomically (A3-10). The journal rotates at
  256 KiB, keeping one older copy (A3-12).
- **Factory (`factory.ts`)**: given the outputs a task needs and the inputs
  the caller has, it chains skills so each step's inputs are fed by the task
  or an earlier step (backward chaining, max depth 5, max 8 steps). Trying a
  producer is transactional: a producer whose inputs cannot be satisfied
  leaves nothing behind. A factory that needs more than 8 steps is refused —
  it is a project, not a pipeline.
- **Mismatches, settled at install/build time (`resolve.ts`), never while a
  skill runs**: I/O (same name+type flows as-is; a convertible type gets an
  adapter from a closed list — `code` never converts implicitly); version
  (highest version satisfying the range wins, otherwise a refusal naming the
  available versions, never a silent downgrade); rules (a skill rule
  contradicting a society rule refuses the install — society rules are hard;
  contradicting a project/session rule drops the skill's rule, the scope
  rule wins, journaled). Contradiction is narrow and explicit: an exact
  duplicate is deduped, only a clear negation (`never X` vs `always X`)
  counts.
- **Rules (`rules.ts`)**: install runs two checks — the static scan (a DO NOT
  INSTALL score refuses, with the findings named) and the rule check above.
  When a skill's text is lazily loaded, the scope rules that bind it are
  prepended as a short block (highest level first, priority stated). Every
  use is recorded in the journal (`levels.recordUsage`), so the rules a skill
  followed survive between runs.
- **No overload**: the compact index (`SkillRef`: name, purpose, ports,
  version, level) is the only thing a search touches. Full skill text is
  read lazily, only for the skill a task actually uses, and only while the
  token budget allows it. `pick.ts` is the one function prompt-intake calls:
  `pickSkillsForTask({ goal, context, index, outputs, inputs, value,
maxSkills })` ranks the compact index (name hits 100, purpose hits 10,
  same weights as the catalog search), composes a factory when outputs are
  given, and never loads full text. It takes the value verdict
  prompt-intake's value checker produced (`ValueVerdict { proceed, reason
}`): a refused request is not searched at all. The verdict maps to
  prompt-intake's real `ValueAssessment` as `proceed = verdict ===
"execute"`, `reason = reasons.join(" ")` — `clarify`, `merge` and `skip`
  all mean "do not search".
- **Token budget (`budget.ts`)**: one request may spend 10,000 tokens on
  marketplace-loaded skill text by default (`DEFAULT_PER_REQUEST_TOKENS`,
  override `ORCHESTRA_TOKEN_BUDGET_PER_REQUEST`), warns at 80%, and stops
  at 100% — the spend is refused, so the total never passes the cap. The
  budget is created fresh per request, so one request can never spend
  another's. Estimation is local (`~4 chars/token`, errs high).
  `compactTranscript` shrinks a transcript extractively without a model
  call (first message kept, newest kept, middle stubbed); a model-based
  summarizer is a caller-provided `Compactor` hook, never a marketplace
  dependency.
- **Service (`native.ts`)**: `SkillMarketplaceNative.Service` wires the
  above: `install` (manifest + scan + rule checks, writes the SKILL.md under
  the level's registry), `uninstall`, `list`, `effective`, `index`,
  `pick`, `composeFactory`, `loadSkill` (the only call that reads a SKILL.md;
  refuses with `BudgetExceeded` past the budget, re-scans the text, prepends
  the rule block, records the use). Production layer: project from Location,
  society from `ORCHESTRA_SOCIETY_ROOT`, session from
  `ORCHESTRA_SESSION_ROOT` when set; a level without a directory is empty,
  not an error.
- **Tests**: `packages/core/test/skill-marketplace-native.test.ts` covers
  manifest parse/derive/semver, install + effective resolution + shadowing,
  factory (chain, adapter, refusal, derived skill), the three mismatch
  types, budget (warn/stop, load refusal, compaction), lazy load (pick
  returns refs only; load reads only the requested skill), and the
  value-verdict skip.

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
outcome it leaves a _stub_ (marked `<!-- orchestra-handoff-stub -->`, with
"(not recorded)" placeholders) when no handoff exists, refreshes an existing stub,
and never overwrites an agent-written handoff. Writing the stub is best-effort
inside settlement: an interruption stays an interruption, anything else is a
warning. Both writers run under one cross-process lock per file and write
atomically (temp + rename, arch3 A3-16): the stub's read-then-write used to
race the agent's write and could clobber a real handoff. The layout follows the three-level memory design (L3, session level);
`memory.md` in the same folder is `SessionMemory`'s job (see "Session memory (L3)" below).

## Session memory (L3) — `packages/core/src/memory/session.ts`, `session/memory-summary.ts`

The session level of the three-level memory design (Б17). One folder per
session, `.orchestra/sessions/<id>/`: `memory.md` (the session's own summary,
≤ 8 KiB, decisions and lessons first, overflow in `scratch.md`), the mandatory
`handoff.md` (see "Session handoffs"), `journal.jsonl` (raw tool-use records —
facts; memory is conclusions, the journal/memory boundary is not to be
erased), `state.json` (idempotency + checkpoint bookkeeping). Capture:
`SessionStep` calls `onToolSettled` once per settled tool call
(`session/runner/step.ts`, wired in `session/runner/llm.ts`); `captureToolUse`
classifies the call (`decision/bugfix/feature/refactor/discovery/change`),
drops noise with the `code--chill` filter (tiny reads go, failures/writes/big
outputs stay), truncates raw I/O at 64 KiB with a `…[truncated: N bytes]`
marker, and is idempotent on (session + tool call) via `state.json` — a retry
records nothing twice. The single write point for `MemoryEngine.remember` is
inside `captureToolUse`. Secrets: the live call site in
`session/runner/llm.ts` passes the foundation scrubber (`memory/scrub.ts`,
`scrubText`) through the `scrub` option on `captureToolUse`; raw tool I/O
never reaches the journal unscrubbed.
Stop: `SessionExecution` settlement calls `finalizeSession` on every terminal
outcome (succeeded, interrupted, failed), best-effort, never failing the
settlement. Empty sessions are skipped (no summary, no model call) but still
get their handoff. The summary wired at settle is extractive (from the
journal): the execution layer has no LLMClient/Model/SessionContext services,
so the cheap-model summary is NOT wired there — `SessionMemorySummary.summarize`
(picks the cheapest model the B10 router offers for tier `trivial`) exists and
is injectable through `finalizeSession`'s `summarize` option, with an
extractive fallback on any failure; wiring it live needs those services added
to the execution node or a hook at the runner drain end where they are in
scope. Compaction: `SessionCompaction.compact`
snapshots `memory.md` + `handoff.md` into `checkpoint/` BEFORE rewriting the
context, and re-injects the checkpointed summary into the checkpoint message
that opens later requests; thresholds from `compaction-policy.ts` are
unchanged. Start: `SessionContext.select` loads the session's previous
`memory.md` + `handoff.md` as an instruction source within a 12 000-character
budget (memory first, markers counted); empty memory costs 0 tokens.
Tests: `packages/core/test/session-memory.test.ts` (15: truncation,
classification, chill filter, idempotency, 8 KiB, 12 000 chars, checkpoint
surviving an interruption, handoff mandatory, router pick, instruction
source).

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

## DoD guards — standby, WIP limit, zones, contracts (`packages/core/src/dod.ts`)

The board (`dod.yaml`, lease 5 min, `LEASE_MS`) is guarded on the claim path
(`Dod.take` / `Dod.next` / `Dod.takeover`, tool `dod` in
`packages/core/src/tool/plugin/dod.ts`). A write is a compare-and-swap:
the file is re-read under a cross-process lock (Flock per file, arch3
№32/№34 — the old lock was process-local, so the CLI board and the server
could both pass the unchanged check and the later rename silently dropped
the earlier take) and retried up to 10 times when another writer saved in
between; the replacement itself goes through a temp file + rename, and the
Windows fallback never unlinks the live file first (arch3 A3-14).

- **Standby (idea #19)**: an item names a reserve agent (`standby` /
  `standby_id`, set by `dod add`); when the holder's lease expires the
  standby takes it over on its own (`dod takeover`, or `dod take` by the
  standby, or `dod check` / `dod block` by the standby — all three record
  `took_over_at` / `took_over_by`). Anyone else taking a stalled item that
  names a standby is refused (`take`, `takeover`, `next`, `check`, `block`,
  and the kanban's `canTake` share the one rule in `refusal`, arch3 M-08),
  so a stranger can no longer create a second writer in one item. A stalled
  item with no standby still passes to anyone — otherwise it could never
  move again, since `takeover` needs a standby too — and the holder
  re-taking their own stale item is never blocked. The society's reserve
  group is named `reserve` (`Zones.RESERVE_GROUP`) and holds no planned tasks.
- **Lease heartbeat (arch3 M-08)**: the lease is a silence timer, and a
  session doing real work is not silent. After every model step the runner
  renews the leases its session holds (`Dod.heartbeatHeld`, called in
  `packages/core/src/session/runner/llm.ts`, best-effort so a board write
  never fails the step); `Dod.heartbeat` renews one item for its holder
  only. A heartbeat renews only leases with under `HEARTBEAT_WINDOW_MS`
  (2 min) left, or already expired while nobody took the item over, and
  writes nothing when nothing is due — a project without a board renews
  nothing. Separately, a holder whose session is provably running never
  reads as stale even past its lease: the `dod` tool passes an `active`
  callback built from `SessionExecution.active` into `take` / `next` /
  `takeover` / `check` / `block` / `release` / `read`, so a long step or
  tool call cannot lose the item mid-work. An idle session is not `active`,
  so its items still go stale once the lease expires. The room path is
  unchanged: its `live` (presence) still decides staleness on its own.
- **WIP limit (idea #20)**: at most 3 tasks in work (`IN_PROGRESS` or
  `BLOCKED`) per group — a 4th concurrent claim is refused with a queue
  message, `next` skips blocked items. Re-taking an item the caller already
  holds is not a new claim and is never blocked. Known gap: `dod check` and
  `dod block` claim a free item without the WIP/zone guards, so they can
  push a group past 3 in work — but since arch3 M-08 they do enforce the
  standby rule above.
- **Zones (idea #25)**: the registry
  `.orchestra/zones.yaml` (`packages/core/src/zones.ts`) maps zone → owner
  group; taking an item from a foreign zone needs a pass
  (`Zones.grantPass`, tool `dod zone_pass`), but a stale claim is an
  automatic pass, so a jam never lasts forever. A caller without a group is
  foreign to every owned zone; a project without a registry has no zones.
  The kanban board below renders zones from the same registry.
- **Contracts (idea #21)**: module interfaces and data formats are fixed in
  writing in `.orchestra/contracts.md` (`packages/core/src/contracts.ts`,
  template via `Contracts.initialize`) before coding; implementation work
  does not start until the document is `accepted` (`dod contracts_accept`) —
  the gate is opt-in by the file itself, a project without it has no gate.
  A change needs a recorded decision (`Contracts.recordChange`: date, what,
  decided by, reason, ADR id or `-`); the long-form ADR format is slice C's,
  this log only names its id. Convergence point for the coordinator: if slice
  C's ADR store lands elsewhere, the log's `ADR:` field points at it.
- Every guard decision is recorded in `.orchestra/dod-events.jsonl`
  (`standby.takeover`, `wip.refusal`, `zone.refusal`, `zone.auto-pass`),
  best-effort: a failed write never fails the claim it records.
  Tests: `packages/core/test/dod-guards.test.ts`,
  `packages/core/test/dod-heartbeat.test.ts` (heartbeat + session activity).

## DoD kanban board (block Б11) — `packages/core/src/dod-kanban.ts`

The kanban is a VIEW over the DoD, not a second store: it reads the same
`dod.yaml` leaves and the same zone registry, and it never offers a card
the claim path would refuse. Columns come from `task_state`:

- `todo` = `NOT_STARTED`, `in_progress` = `IN_PROGRESS`,
  `blocked` = `BLOCKED`, `failed` = `FAILED`,
  `done` = `DONE` + `OUT_OF_SCOPE`; an unknown state lands in `todo`
  with its real state kept on the card.
- A card shows owner, steps done/total, zone, and whether the viewer may
  take it. `canTake` is exactly `Dod.mayClaim(...) === undefined` (the same
  function the claim path uses), so the board and the take tool cannot
  disagree: basic refusal, WIP limit, and zone pass are all honoured.
- A foreign-zone card is read-only for the viewer (no take, reason shown);
  an explicit pass or a stale claim in a foreign zone makes it takeable.
  The host view never takes: `canTake` is false everywhere with the reason
  "Only guests take items; the host frees them" — the host frees held
  cards instead.
- Human cards (Kanzo's Human marking): a leaf with `human: true` in
  `dod.yaml` is a card for a human only — agents never take it. The guard
  lives in `Dod.guardOutcome`, so every start path refuses it (take,
  takeover, `mayClaim`, `next`, and the board's `canTake`): the refusal is
  "<id> is marked for a human; agents do not take it". The card carries
  `human: true` (also in `kanban.yaml` and the `dod` tool's lines), and
  `counts.free` excludes it for guests — for the host it still counts as
  free, since the host works it by hand.
- Cheap answers (Kanzo's format, one call = one action): the agent-facing
  reads use one plain-text line per card — `Dod.renderItemLine`
  (`ID [STATE] title (done/total)` plus owner, waits, `for a human`,
  steps and verification when present), shared by the prompt section
  (`Dod.renderStatus`: the JSON body is gone) and the `dod` tool. The room
  API keeps JSON for the UI. Measured on a 12-card board with the local
  chars/4 estimate: JSON body ≈357 tokens vs text lines ≈174 tokens
  (0.49×); the longest card line is 31 tokens and the take
  acknowledgement ("You hold L-002 now.") is 5 — inside Kanzo's 10–60
  tokens per response.
- The board shape is `Room.DodBoard` (`packages/schema/src/room.ts`):
  `columns[]` (`DodBoardColumn`: id, title, cards), `zones[]` (name,
  ownerGroup, mine), `counts` (total, done, inProgress, blocked, failed,
  free). `status` is `disabled` when the room has no `dod.yaml`.
- API (`packages/protocol/src/groups/room.ts`): `room.dod.board` (host,
  GET `/api/room/:roomID/dod/board`) and `room.guest.dod.board` (guest).
  The guest's group comes from the member record (`Room.Member.group`,
  assigned by the host through `room.member.update` — omitted keeps the
  group, an empty string clears it), never from the request: the old
  self-asserted `?group=` query is gone, and a guest without a group is
  foreign to every zone. The claim path (`room.guest.dod.claim`) passes the
  same member group to `Dod.take`/`Dod.next`, so board and claim agree:
  a zone member can take its zone's cards, and the board never offers a
  card the take would refuse. Both are in `GUEST_PATHS`, or the auth
  middleware blocks guest tokens. Server handlers in
  `packages/server/src/handlers/room.ts`; the guest handler strips `verify`
  from cards (`hideBoardExecution`, mirroring `hideDodExecution`). The
  generated client (`bun run generate` from `packages/client`) exposes
  `room.dod.board` / `room.guest.dod.board` and `room.dod.release`.
- TUI (`packages/tui/src/component/room-dod.tsx`): `RoomDodRows` takes an
  optional `loadBoard` prop and gains a `board`/`list` toggle (shown only
  when a board loaded). The board renders the 5 columns side by side with
  a zones legend; a blocked reason sits on its own line under the card (a
  finished card shows none — the Done column already says it). The board
  loads and reloads together with the list (room-feed long-poll + 5s poll),
  so no new transport. Wired at all call sites: `project-tree.tsx`
  (hosted: `room.dod.board`; joined: `room.guest.dod.board`) and
  `room-chat.tsx` (guest board). Shared take/submit/release actions live in
  `DodItemActions`; freeing another person's card still needs a second
  click.
- Web app (`packages/app/src/dod/route.tsx`, route
  `/server/:serverKey/room/:roomID/dod`): the host board — 5 columns in a
  grid (stacked on narrow screens), 5s poll, a release button on held
  cards. Copy uses `dod.board.*` i18n keys
  (`packages/app/src/runtime/i18n/en.ts`); the host's generic take refusal
  is not shown (it would repeat on every card), `waits` is shown instead.
- Tests: `packages/core/test/dod-kanban.test.ts` (16: columns, owner/mine,
  refusals, foreign zone, pass, stale auto-pass, WIP limit, host view,
  counts, zones, disabled, no-zones, human card),
  `packages/core/test/dod.test.ts` (34, incl. the token-cost test for the
  text board), `packages/core/test/dod-guards.test.ts` (incl. the human
  take/takeover/next refusal),
  `packages/tui/test/component/room-dod.test.tsx` (13: 9 list + 4 board —
  toggle, zones line, foreign-zone read-only, take from the board), and
  `packages/server/test/room.test.ts` ("the kanban board groups the DoD by
  state for host and guest": host board grouped, nothing takeable; guest
  board free card takeable, done card not; 401 without a guest token).
  Verify: `bun test test/dod-kanban.test.ts test/dod.test.ts` in
  `packages/core`; `bun test test/component/room-dod.test.tsx` in
  `packages/tui`; `bun typecheck` in `packages/app`.

## Block Б16 — project state files in `.orchestra` — `packages/core/src/project-files/`

- Idea: every project folder carries its state on disk in `.orchestra/`
  — a mirror of what lives in the database and the journal, not a second
  source of truth. A project restores from its files without the DB; a
  move is a folder copy. Divergence file vs DB is an error visible in
  `health.json`, never silent drift. Secrets are never in files and never
  in git. DoD is in git, memory/notes are not.
- Core framework (`packages/core/src/project-files/`):
  - `errors.ts` — one error, `ProjectFileError` (`Schema.TaggedError`
    `"ProjectFiles.Error"`, fields `file`/`kind`/`message`; kinds
    `corrupt`|`missing`|`divergent`|`write-failed`|`restore-failed`|`invalid`).
    A corrupt file fails loudly, never reads as empty.
  - `format.ts` — one place for parsing/writing: YAML via `Bun.YAML`,
    JSON via `Schema.fromJsonString`, JSONL (missing file = empty log, bad
    line = corrupt with `file:line`), atomic writes via `WriteAtomic`,
    best-effort `appendJsonl` with 1 MiB rotation. Plain
    `node:fs/promises` — core does not depend on `@effect/platform`.
  - `registry.ts` — the registry of every known file: `FileDescriptor`
    `{rel, base, dir, kind, purpose, git, source}`; `source` is `file`
    (the file IS the store), `db` (mirror of DB/journal), or `derived`
    (generated). `base` is `orchestra` (inside `.orchestra/`, default) or
    `project` (the project directory itself — only the native skill
    registry lives there). `descriptorForPath` returns the exact
    descriptor, else the longest enclosing directory descriptor, so a
    file inside `notes/` is a note, not `unknown`. The `.gitignore` split
    derives from `gitignoreLines()` — the single source of truth, also
    used by `packages/core/src/memory/index.ts`.
  - `index-file.ts` — `index.yaml`, the manifest of `.orchestra` (path,
    kind, purpose, updatedAt, size, sha256, count): it exists because
    `notes/`, `plots/`, `skills/` and the rest were invisible to agents
    (only DoD and memory reach the prompt). Never lists itself;
    `snapshots/` is one entry with a count; an unregistered file is listed
    as `unknown`. Covers `.orchestra/` only — project-base files are
    discovered via the registry and health-checked, not listed here.
  - `health.ts` — `health.json`: one line per registered file
    (`ok`|`missing`|`corrupt`|`divergent`|`unchecked`) and one overall
    status (`healthy`|`degraded`|`unhealthy`|`unchecked`). Existence and
    parseability are checked by the core; divergences come from the
    slices via `checkHealth(directory, divergences)`. Base-aware: a
    project-base file is checked at its real sibling path.
  - `snapshot.ts` — snapshots of the whole `.orchestra` (minus the
    snapshots themselves) plus the registered project-base state files
    (base `project` descriptors — today only `native-skills/skills.json`),
    which ride along under the `__project__/` prefix inside the snapshot
    and restore back to the project directory; only files the registry
    knows are included, never a stray project file. A manifest lists
    every file it holds; keep 7, prune oldest first.
    `restoreSnapshot` verifies manifest + every listed file (exists and
    parses) BEFORE writing anything, so a broken snapshot fails with the
    current files intact; files that exist now but not in the snapshot
    are left alone and reported as skipped. Old snapshots (no
    `projectFiles` in the manifest) restore as before.
  - `sync.ts` / `restore.ts` — the two directions. Sync pulls state from
    the owning subsystem into the file (mirror); restore rebuilds DB
    state from the files after the DB is gone. Every syncer/restorer runs
    best-effort: one file failing (including a syncer that dies — missing
    service, unexpected defect) is reported `failed`, never crashes the
    whole run. After both, the index refreshes and health recomputes.
- State files (S1, `files-state.ts`): `orchestra.json` (project config,
  validated against the real `Config.Info` schema, file-owned),
  `rules.yaml` (mirror of KV rules, restorer writes back per scope),
  `tasks.yaml` (projection of DoD leaves, derived, no restorer),
  `decisions.yaml` (ADR index over `decisions/`, derived),
  `society.yaml` (federation groups from KV, restorer writes back),
  `budget.yaml` (projection of `Group.budget` — no separate budget store
  exists; restorer patches the budget back onto the group),
  `briefing.md` (file-owned, no briefing store exists),
  `handoffs.md` (append-only log, file-owned),
  `lifecycle.json` (file-owned, no project-lifecycle store exists).
  All git-tracked except `handoffs.md` and `lifecycle.json`.
- Data files (S2, `files-data.ts`): `kanban.yaml` (snapshot of the live
  host-view board; `compareKanban` returns divergences for health),
  `dod-history/` (dated DoD snapshots on change, cap 30),
  `errors.jsonl` / `events.jsonl` / `usage.jsonl` (append-only mirrors
  of the autoloop journal, watermark = last `seq` in the file plus its
  rotated `.1` copy; never rewritten — replaying would mint new
  sequences), `quarantine.jsonl` (full rewrite of the
  `autoloop_quarantine` set; the restorer re-quarantines every listed
  fact, so a poisoned fact stays quarantined after a file-only restore).
  All `git=false` (runtime data). DoD/zones need no syncer — the files
  already ARE their stores.
- Integrations + skills (S3, `files-integrations.ts`): `mcp.yaml`
  (per-project MCP servers — the fix for MCP being global-only; secrets
  only as `{credential: "<id>"}` references, a secret value is rejected
  loudly), `integrations/` + `INTEGRATE.md` (`integrate(directory, spec)`
  — recognise catalog/MCP/REST/provider → validate → install manifest
  `.orchestra/integrations/<name>.yaml` → offline verify → regenerate
  the doc; CLI wiring is `orchestra integrate <manifest.yaml|json>`
  (`packages/cli/src/commands/handlers/integrate.ts`, `--dry-run`
  validates only, `--force` overwrites) and `orchestra integrations
list` (`packages/cli/src/commands/handlers/integrations/list.ts`,
  read-only). Live smoke test: `packages/cli/test/live-smoke.test.ts`
  probes a running server read-only (`GET /health`, and with
  `ORCHESTRA_LIVE_PASSWORD` also `GET /api/info` with Basic auth) via
  `packages/cli/src/services/live-smoke.ts`; the live tests SKIP when
  the server is unreachable (one quick probe at load), and the probe
  logic is verified against a local in-process server, never the live
  one. Server URL: `ORCHESTRA_LIVE_URL`, default
  `http://127.0.0.1:17890`. `native-skills/skills.json`
  (project-base validated registry via the existing
  `loadLevelDetailed` — damage is surfaced as a health divergence, never
  a silent empty level; the damage handling itself lives in
  `skill-marketplace/levels.ts` and is not redone here).
- What is NOT covered: restore is additive per scope/group (a scope
  deleted from `rules.yaml` by hand is not pruned from KV); negative
  budgets are not schema-rejected; handoff appends are single writes
  without a lock (same tradeoff as the DoD event log); live probes
  for integrations (server start, `tools/list`, `GET /models`) are not
  implemented — verification of an install is offline shape-only (the
  live smoke test above probes the server itself, not an integration).
- Tests: `packages/core/test/project-files-core.test.ts` (17: index,
  health incl. divergence + base-project path, snapshots incl.
  project-base files and the stray-file rule, sync/restore
  frameworks on a real temp DB+KV, gitignore split, registry),
  `project-files-state.test.ts` (19), `project-files-data.test.ts` (19),
  `project-files-integrations.test.ts` (17). Verify: `bun test
test/project-files-core.test.ts test/project-files-state.test.ts
test/project-files-data.test.ts test/project-files-integrations.test.ts`
  in `packages/core` (72 pass); `bun typecheck` in `packages/core`
  (0 errors in the `project-files/` files). CLI:
  `packages/cli/test/integrate.test.ts` (9: spec registration, real
  spec→handler dispatch, YAML/JSON load, install + `mcp.yaml` entry,
  dry-run writes nothing, reinstall needs `--force`, secret rejected)
  and `packages/cli/test/live-smoke.test.ts` (4 pass + 2 skip when the
  live server is down: probe logic on a local server, unreachable =
  not reachable, unhealthy = probe fails). Verify: `bun test
test/integrate.test.ts test/live-smoke.test.ts` in `packages/cli`.

## Block Б17 — three-level memory, L2 (project) + L1 (society) — `packages/core/src/memory/levels.ts`

- Idea: memory is conclusions and context, not the journal (Б2: the
  journal is facts). Three levels, promotion only up and only curated:
  a session proposes into the project daily, promotion moves at most 5
  facts per session into the project `MEMORY.md`; only decisions,
  lessons and rules cross from a project into the society, and only a
  human or the council moves them. Nothing leaks on its own — without
  an explicit promotion call, nothing from a lower level appears above.
- L2 — project, `<project>/.orchestra/memory/` (registered in the Б16
  registry, `project-files/descriptors-state.ts`: `memory/` dir,
  `index.json`, `MEMORY.md`, `daily/`, `actors/`; all `git: false` —
  memory is local, like notes):
  - `index.json` is the store of promoted facts (`{version: 1, facts:
[{id, text, type, tags, painful, sourceSession, created,
promotedAt}]}`); `MEMORY.md` is its render (one bullet per fact,
    ≤ 12 KiB, rewritten on promotion — hand edits are overwritten).
  - `daily/YYYY-MM-DD.md` holds candidates, one structured line each
    (`- [ ] <id> | <type> | painful|routine | session:<id> |
tags:<a,b> | <text>`); `[x]` = promoted, `[-]` = rejected.
    Unparseable lines are free-form notes, ignored by promotion.
  - `actors/<name>.md` — one dated line per note, name a lowercase slug.
  - `promoteSessionFacts(root, sessionId)` — the only way into
    `MEMORY.md`. The cap is 5 per session in total (facts the session
    already promoted count, so a second call cannot smuggle a 6th
    through). A fact qualifies only if it would hurt to restore:
    `painful: true`, or type `decision`/`bugfix`/`discovery`. Over the
    12 KiB budget a fact is refused with reason `budget` — the file is
    never silently truncated. Skipped facts stay candidates and are
    reported (`not-painful`/`over-limit`/`budget`/`duplicate`).
  - Search is progressive disclosure over the file store, on the
    existing offline BM25 rank (`memory/rank.ts`) — no vector DB, no
    Chroma, no Python: `searchProjectMemory` returns a compact index
    (id, kind, title ≤ 160 chars, score, `approxTokens` ≤ ~100);
    `timelineProjectMemory` returns chronological context (±2 around
    given IDs, else the most recent); `getProjectMemoryFacts` returns
    full details only for the IDs already filtered. The query is plain
    text for the ranker, never interpolated into SQL/FTS/regex, so
    injection strings match nothing and never throw.
- L1 — society, `<society>/.orchestra/memory/` (a different root from
  any project; a project call can never write into it): `MEMORY.md`,
  `charter.md`, `rules.md` (`## hard` / `## soft`, bullets
  `- [applies] text`), `decisions/<fact-id>.md`,
  `lessons/<fact-id>.md`, `agents/<name>.md`, `blocks/<id>.md`,
  `daily/YYYY-MM-DD.md`, `archive/`, `members.md`, `acl.yaml`.
  - Minimal ACL (`SOCIETY_ACL` in `levels.ts`): human writes
    everything; the council writes `decisions/`, `lessons/`,
    `rules.md`; the orchestrator and agents write nothing directly —
    `writeSocietyFile` refuses them with `denied` and points at
    `proposeToSociety`, which appends a proposal line to the society
    daily. `acl.yaml` is a generated human-readable mirror of the
    table; enforcement reads the table, not the file.
  - `promoteProjectToSociety(projectRoot, societyRoot, {by, kind,
factIds})` — `kind` is `decision`/`lesson`/`rule`; `by` must be
    `human` or `council`, anyone else gets `denied`. A promoted rule
    is appended to the `## soft` section of `rules.md` as
    `- [project:<name>] <text> (факт <id>)`; decisions/lessons become
    one file each, recording their source project and fact id.
  - Rule precedence (`resolveRules`): hard society rules first, then
    hard project rules, then soft rules most-specific-first
    (specificity = count of non-wildcard segments in `applies`; a
    society soft rule wins a tie).
- Secrets: the foundation scrubber (`memory/scrub.ts`, `scrubText`) is
  wired as the default for every write (`WriteOptions.scrub` overrides it
  per call); no text reaches the files unscrubbed. Do not grow a second
  scrubber here.
- What is NOT covered (other slices): the full ACL model beyond the
  minimal table above. The existing Letta-style memory
  (`memory/index.ts`: blocks + `archive.jsonl` in the same
  `.orchestra/memory/` directory) is untouched — the L2 files coexist
  with it, and `index.json` here is a different file from the Б16
  `index.yaml` at `.orchestra/index.yaml`.
- Tests: `packages/core/test/memory-levels.test.ts` (20: promotion,
  no-leak, 5-per-session cap, painful-only, 12 KiB fail-closed,
  idempotence, cross-root isolation, actors, compact search,
  timeline, get-by-id, injection strings, L1 ACL, proposals,
  L2→L1 promotion, rule precedence, `acl.yaml`, init idempotence,
  scrub hook). Verify: `bun test test/memory-levels.test.ts` in
  `packages/core` (20 pass); `bun typecheck` in `packages/core`.

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

## Recovery mini-chat — `packages/core/src/recovery/` (Б12)

The fallback entry point when Orchestra itself is broken and the normal UI
cannot be entered. It is NOT a general escalation step: it exists only for
the case "the program itself is broken".

- **Button**: the app error page (`packages/app/src/shell/errors/error.tsx`,
  the `ErrorBoundary` fallback in `app.tsx` and the session route error
  fallback) has an «Исправить» button (`error.page.action.fix`: "Fix with
  AI" / "Исправить") next to Restart/Reload. It navigates to `/recovery`
  with the error summary in the URL hash, so the chat opens with it pasted.
- **Page**: `packages/cli/src/services/recovery-page.ts` — plain HTML +
  vanilla JS, no framework, no build step, no external resources. Served by
  the CLI web-UI handler (`packages/cli/src/services/web-ui.ts`) at
  `/recovery` BEFORE the app assets load, so it opens even when
  `packages/app/dist` is missing or the bundle is broken. Tight CSP
  (inline script/style only, `connect-src 'self'`). The page itself is
  unauthenticated (like the sign-in screen); the API calls behind it use the
  normal server credential and show a sign-in hint on 401.
- **API** (`packages/protocol/src/groups/recovery.ts`, handlers
  `packages/server/src/handlers/recovery.ts`): `GET /api/recovery/models`
  lists every enabled model in catalog order (the catalog hides providers
  it cannot serve; no provider is hardcoded in or out); `POST /api/recovery/chat` runs one autonomous repair
  round. The chat input is capped (T3-6): at most 20 messages
  (`Recovery.RecoveryChatTranscript`) of at most 8000 characters each, one
  round at a time per server (a second concurrent request is refused with
  503 — `runRepairRound` in the handler, exported for tests), and a round
  times out after 10 minutes. Both handlers call `requireLocationDirectory()`
  first (T3-11), so a missing directory answers 404 like the other catalogs.
  Registered as a location-middleware group in
  `packages/protocol/src/api.ts`; the client is regenerated with
  `bun run generate` from `packages/client`.
- **Repair agent** (`packages/core/src/recovery/`): `Recovery.Service` is a
  location node in the per-location graph (`packages/core/src/instance.ts`,
  `nodes` — next to `Model`/`ModelResolver`, NOT in the server's global
  `applicationServiceNodes`: a location node there breaks the server layer
  graph with `Unbound layer node: @orchestra/Location`). It resolves the chosen
  model through the normal `Model` + `ModelResolver` path (same credential
  store as sessions), then `runRepairLoop` calls the model with four tools —
  `read_file`, `write_file`, `list_files`, `run_shell` — up to 12 rounds.
  Tools are confined to the Orchestra checkout (`resolveRepoRoot` in
  `service.ts`: the ancestor holding `packages/core`, `ORCHESTRA_REPO_ROOT`
  override, cwd only as a last resort — never the server's working
  directory, which is the user's project). Paths are resolved with
  `realpath` (`resolveInRootReal` in `tools.ts`), so a symlink inside the
  repo that points outside it is refused, including for not-yet-created
  files; `.env*`, `credentials*`, `*secret*`, `*.pem`, `*.key`, `id_rsa*`,
  `*.db*`, `*.sqlite*`, `.git/`, `.ssh/` and the config files
  (`orchestra.json`, `opencode.json` — provider headers there can carry an
  `Authorization` key) are protected for both reading and writing. Writes
  publish atomically (temp file + rename). The shell runs in the real root
  with a 60 s timeout, a 20 000-char command cap, and a denylist that
  refuses `rm -rf` at any absolute/home/variable path, `find -delete`,
  `git clean -f`, `git push --force`, `dd … of=`, piping into a shell,
  `chmod 777`, `curl`/`wget` uploads and any fetch outside localhost.
  The agent works autonomously — no permission prompts — and ends its
  answer with an `Исправлено:` line when it fixed something. The verdict
  parser (`parseFixed` in `agent.ts`) is fail-closed: any `Не исправлено:`
  / `Not fixed:` anywhere means not fixed, and the positive marker counts
  only at a line start or right after a sentence boundary, never
  mid-sentence — a quoted mention is not a verdict. `RecoveryResult.root`
  says which checkout was actually repaired. A model or provider failure
  is returned as a reply, not an HTTP error: the user is already looking
  at a broken Orchestra, and a bare 500 with no words helps no one.
- **Model list**: `listRecoveryModels` offers every model the catalog
  reports as available (the catalog already hides providers it cannot
  serve — no key, disabled plugin), in catalog order. No provider is hardcoded out: Anymodel is offered
  again when the catalog says it works, and a provider that fails at call
  time is reported as a reply, not a crash.
- **After the fix**: the page shows the `Исправлено:` banner with an
  "Открыть Orchestra" button (back to `/`) and a restart hint
  (`orchestra service restart`) when code changed.
- Verify: `packages/core/test/recovery.test.ts` (model filter, repair loop
  with a scripted test model, tool confinement, shell denylist) and the
  `/recovery` case in `packages/cli/test/web-ui.test.ts` (page serves without
  auth or a built shell). Handler rule: yield location services (e.g.
  `Recovery.Service`) INSIDE each endpoint's `Effect.fn`, never in the group
  builder — the builder runs at server startup, where no location exists
  (`Service not found: @orchestra/Recovery`). Web-UI rule: inside
  `Effect.gen` return the response value directly, never
  `return Effect.succeed(...)` — the latter returns the Effect object as the
  response and the request hangs with no bytes.

## Web UI shell — stale dist, Windows backslashes, white screen (perf-white)

- Root cause of the 2026-11-07 white screen (Windows only): `sourceAssets()`
  in `packages/cli/src/app-assets.ts` built the asset map from
  `fs.readDirectory(root, {recursive: true})`, whose paths use the platform
  separator — `_assets\index-abc.js` on Windows. `serveUI` looks assets up
  by URL, which always uses forward slashes, so every nested asset 404'd
  while `index.html` (no separator in its name) loaded fine. Edge reports
  the empty 404 as "blocked due to MIME type", so the console showed MIME
  errors and the page stayed white. The packaged CLI was never affected:
  `packages/cli/script/app-assets.ts` already normalizes keys at archive
  build time. Fix: `normalizeAssetKey()` in `app-assets.ts`, applied in
  `sourceAssets()`, in `AppArchive.decode()`, and defensively to the request
  key in `serveUI` (`packages/cli/src/services/web-ui.ts`).
- Static 404s carry `content-type: text/plain; charset=utf-8` (never a bare
  404), so the browser reports a 404 instead of a MIME mystery.
- `orchestra serve` checks the dist at startup (`WebUi.checkStartupHealth`,
  called from `packages/cli/src/server-process.ts`): missing dist, shell
  references to assets that do not exist (`findMissingAssets` in
  `app-assets.ts`), or a dist older than the app sources (source mode only)
  each log a loud warning with the rebuild instruction. The warning goes to
  the serve console via `console.error`: `Effect.logWarning` would land in
  the shared opencode log file instead (stderr only with
  `ORCHESTRA_PRINT_LOGS=1`), where nobody running serve looks.
  `git pull` never rebuilds the app — `dist/` is not in git — and never
  updates the installed binary: `bun run build` in `packages/app`, then
  restart serve.
- A rebuild while the server runs is picked up without a restart (source
  mode only): the web-UI handler re-stats `dist/index.html` per request
  (one syscall, throttled to once a second) and, when it changed, re-lists
  dist and swaps the whole asset map at once — only after the new build
  validates (every asset the new shell references exists), so a shell and
  its assets can never come from different builds. A build still in
  progress keeps the previous build and logs once. Content reads stay lazy,
  so the swap compares the new shell against the shell text stored with the
  snapshot — and the served shell is that stored text too (`serveUI` takes
  the snapshot's `indexHtml`): reading `assets["index.html"]` again would
  return the current disk bytes, not the snapshot's, so a rebuild landing
  mid-flight used to pair a new shell with the old asset set even though
  the guard had kept the previous build (found live 2026-11-07: a broken
  shell written to disk was served at once while the guard logged
  "keeping the previous build"). The embedded archive is immutable,
  so no reload applies there.
- The shell never comes from the service worker's precache:
  `packages/app/vite.pwa.ts` excludes `index.html` from the precache and
  serves navigations `NetworkFirst` (3 s timeout, cached shell only when
  the server is unreachable). Hashed assets stay precached — their names
  cannot go stale. `skipWaiting: false` / `clientsClaim: false` are
  deliberate: an open tab keeps its complete build (a new worker taking
  over mid-session would make the tab's next lazy chunk 404 against the
  new dist); freshness comes from the network-first navigation, not from
  the takeover. `index.html` is served `no-cache` (revalidated every time).
- A failed bundle no longer means a white page: `packages/app/index.html`
  carries a loading fallback inside `#root` and `public/orchestra-boot.js`
  (plain script, runs before the entry module) shows an error page — what
  happened, reload / clear-cache / rebuild-and-restart hints, a recovery
  link — when a script chunk fails or the app has not mounted within 10 s.
  `packages/app/src/entry.tsx` removes the fallback and sets
  `root.dataset.opencodeRendered` after render. The boot copy is English
  only: the app's own `error.page.*` strings have no Chinese translation
  either, so a Chinese browser sees the same English here as after mount.
- Verify: `packages/cli/test/app-archive.test.ts` (backslash keys),
  `packages/cli/test/app-assets.test.ts` (normalization, shell references,
  sourceAssets with a Windows-shaped listing), `packages/cli/test/web-ui.test.ts`
  (404 content-type, Windows-keyed map served by URL key, shell text served
  from the accepted snapshot, not a later disk edit).

## Foreground server lifecycle — `packages/cli/src/services/server-lifecycle.ts` (B14 live fix)

B14 (2026-11-06): the live foreground server (pid 31637) died silently —
no error in `serve6.log` (it ends with benign ENOENT `team-notes.md`
warnings), no OOM-killer trace the operator could read (`dmesg_restrict=1`
on this machine, so "dmesg is clean" is unverifiable; core dumps off,
`ulimit -c 0`), memory at the limit. The exact cause was NOT established;
OOM-kill under memory pressure is the most likely hypothesis, unproven.
Nothing noticed the death: the next start had no idea the previous run
ended uncleanly, and the old process had ignored SIGTERM while the
replacement fought it for the port. This section is the fix, for
`orchestra serve` in default (foreground) mode only:

- PID lock: `ServerLifecycle.acquireLock` in the data directory, one file
  per port (`server-<port>.lock`, `server.lock` when the OS picks the port),
  created exclusively (`wx`) with `{pid, hostname, port, mode, startedAt}`.
  A second foreground start fails fast with `ServerAlreadyRunningError`
  naming the live incumbent's pid, start time and port, instead of
  fighting it for the port or silently sharing the database. A lock naming
  a dead pid is stale and is reclaimed, loudly. Released by a finalizer.
- Shutdown marker: `server-state.json` in the data directory, written at
  startup with `cleanShutdown: false` and updated to `true` with
  `{at, reason}` on graceful shutdown. A start that finds no clean marker
  reports the previous run as UNCLEAN — in the Effect log (the opencode log
  file) AND as one `[lifecycle] ...` line on stdout, so it is visible in
  `serve.log` next to "server listening" (Effect logs never reach that
  file). Verdicts: `first` / `clean` / `unclean` / `unknown` (corrupt state
  never blocks a start).
- The marker is written by a FINALIZER keyed on `reachedListening`, not by
  code after `waitForTermination()`: `NodeRuntime.runMain` interrupts the
  main fiber on SIGINT/SIGTERM — and its signal handler was registered
  before ours, so the interruption's finalizers run before our own signal
  listener even fires (verified live: the finalizer logged before "signal
  received"). The generator therefore never continues past the wait. The
  finalizer is the last one registered, so the first to run on scope close
  (LIFO), before any wedged server finalizer can block it. The recorded
  signal refines the reason when the resume wins the race; otherwise the
  marker says "graceful shutdown".
- `waitForTermination` owns SIGINT as well as SIGHUP/SIGTERM: before this
  fix, Ctrl-C killed the process through the default disposition, so no
  finalizer — and no shutdown marker — ever ran for the most common
  foreground stop. It also starts the 10s forced-exit clock at signal
  receipt, not after the finalizers: a wedged PTY/database finalizer must
  not make SIGTERM look ignored (the B14 class).
- Watchdog: `scripts/server-watchdog.sh` runs `serve` from the worktree
  and restarts it only on unclean exits (exit code, state file, live lock
  holder), with backoff 5/10/20/40/60s capped at 60s and a restart cap
  (default 5 inside a 600s sliding window, `ORCHESTRA_WATCHDOG_MAX_RESTARTS` /
  `ORCHESTRA_WATCHDOG_WINDOW_SECONDS` / `ORCHESTRA_WATCHDOG_BACKOFF_BASE`). Bun
  is resolved once at startup (`ORCHESTRA_BUN`, then `command -v bun`, then
  `/opt/hatch-image/bin/bun`, `$HOME/.bun/bin/bun`, `/usr/local/bin/bun`):
  systemd runs the script with a minimal PATH that has no bun, so a bare
  `bun` failed every start with exit code 127 (2026-11-07); with bun nowhere
  the watchdog exits 1 loudly instead of spinning restarts. A
  lock counts as held only when the pid is alive and started within a
  window around the lock's startedAt — up to 120s before it (the server
  writes the lock seconds after its process starts) and at most 2s after
  it — so a recycled pid is detected and the stale lock ignored. A clean
  shutdown or a lock held by a live server stops it (exit 0); past the cap it
  gives up loudly (exit 1).
  It is a shell loop, not an in-process supervisor: a supervisor inside
  the process it watches cannot report its own SIGKILL.
- Autostart (2026-11-07, watchdog-autostart): the watchdog does NOT survive
  a VM reboot on its own — nothing started it after the 2026-11-06 reboot
  (uptime 44 min, log cut 22:30 +04), and the live server died silently 3
  times that day. Mechanism chosen: a systemd unit, NOT cron — this VM has
  no cron daemon at all (no crontab binary), while systemd is PID 1 and
  reports `running`. Files: `scripts/orchestra-watchdog.service` (template
  with placeholders, never installed directly) +
  `scripts/install-watchdog-autostart.sh` (renders, installs, enables;
  `--dry-run` / `--check` for a no-touch preview; `--scope user` default
  with `loginctl enable-linger`, `--scope system` for a system unit). The
  unit starts ONLY the watchdog; `Restart=no` is deliberate so systemd
  never resets the watchdog's restart cap. Guards, all in the watchdog
  script: a second watchdog exits 0 at once on the flock
  (`$DATA_DIR/watchdog.lock`, released by the kernel on death, so a stale
  file never blocks the next start); a pre-flight check exits 0 without
  starting `serve` when a live server already holds a lock; `--probe` is
  the read-only form of that check (exit 0 + holder, else exit 1) used by
  the installer. The installer starts the unit after install ONLY when no
  server and no watchdog is live — otherwise it leaves the unit enabled
  for the next boot and starts nothing. Two install-time facts the operator
  must get right: the service user must own the data directory (state/lock
  files are 0600; a mismatch refuses the install), and secrets come from
  `%h/.config/orchestra/watchdog.env` (mode 0600, created by the operator),
  never from the unit. On this VM the live server runs as root (data dir
  root-owned), so the install is `--system --service-user root` (or a user
  unit as root); a move to an unprivileged user means re-running the
  installer as that user. Verify:
  `packages/cli/test/server-watchdog-autostart.test.ts` (11 tests: probe
  live/stale/recycled/absent, pre-flight no-start, second-watchdog flock,
  installer dry-run + `systemd-analyze verify`, bun resolution via
  ORCHESTRA_BUN / fallback location with a systemd-like PATH, loud failure
  on a broken ORCHESTRA_BUN). NOT yet verified on a real
  reboot — that is the remaining check: after the next reboot, `systemctl
status orchestra-watchdog` + `watchdog.log` must show the watchdog up and
  the server back on port 17890 with no operator action. The installer was
  deliberately never run for real in this change (no live systemd change
  without separate approval); only code, scripts and docs.
- Deliberately NOT covered: `orchestra serve --service` (already owns
  startup through ServiceClaim + registration; sharing one state file
  between the modes would confuse the verdict) and `serve --stdio` (owned
  by the parent's lease). `/health` is unchanged: it is unauthenticated
  and by design carries no pids or paths.
- Verify: `packages/cli/test/server-lifecycle.test.ts` (7 tests, real temp
  dirs, no mocks) and the live scratch-server checks (scratch config/data
  dirs, ports 17891+, SIGKILL/SIGTERM/SIGINT/second-instance/watchdog).
  NOTE: full `bun typecheck` in `packages/cli` does not fit this 7.7 GB
  VM — killed by the OOM-killer 3 times (SIGKILL, 0 TS errors reported)
  even with no other typecheck running; verify types on a bigger machine.
  Lint on the changed files is clean (`oxlint`, 0 warnings/errors).

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
- Version match ignores build metadata (`packages/client/src/service-version.ts`
  `matchesVersion()`): a server from another commit of the same release
  (`1.0.0+<sha>`) is reused with a warning, not restarted — a restart costs a
  full cold start after every `git pull`. A different release still replaces it.
- A server stuck in its startup state gets a budget that doubles with every
  replacement (`waitingTimeoutFor()`: 30 s, then 60 s, capped at half the
  `promiseTimeout`), so a slow machine eventually gets a window long enough
  for a cold boot. Three timed-out probes evict a server that never answers
  at all; one that answered recently is alive but slow, so it is only evicted
  after silence longer than the waiting budget.
- The managed server spawns from the checkout root (`ServiceConfig.options()`
  `cwd: selfRoot()`, `packages/cli/src/util/process.ts`): Bun resolves the JSX
  runtime from the tsconfig in the working directory, so a server spawned from
  a project directory dies at import time (`react/jsx-dev-runtime`). The
  service-mode server chdirs to the user's home at startup, so the spawn
  directory only affects module resolution.

## Themes — `packages/theme`

- Token resolution (`src/tui/resolve.ts`) enforces readability floors via
  `ensureReadable()`: no foreground/background token pair below 3.0:1 contrast.
  Transparent-background themes are exempt by design.
- Theme config writes are serialized through one promise queue; `preview()`
  never writes, `commit()` resolves after the write. Removed built-in themes
  migrate via `LEGACY_THEME_NAMES`.
- The `neural` role already exists in the TUI theme schema
  (`packages/theme/src/tui/schema.ts`: `text.neural`, optional) with resolve
  pass-through (`resolve.ts`) and v1-migrate defaults
  (signal/synapse/spark/dormant from hue tokens). Themes written before the
  role existed resolve without it; `neuralPalette()` in
  `packages/tui/src/component/neural.tsx` falls back to a monochrome network.
- TUI theme assets (`packages/tui/src/theme/assets/`, incl. `v2/`) carry no
  `$schema`: the `https://opencode.ai/theme.json` line was removed — the
  value was editor-only and never validated at runtime (`$schema` is only an
  optional string in the config schema). UI theme JSONs already point
  `$schema` at the project-owned `desktop-theme.schema.json` (see the D1
  section below); the Orchestra project's avatar falls back to the local
  `/favicon-v3.svg` instead of `opencode.ai/favicon.svg`.
- **Web dark-token invariant (block D1):** non-v2 tokens in
  `packages/ui/src/styles/theme.css` must switch to dark under
  `:root[data-color-scheme="dark"]`, with the OS
  `@media (prefers-color-scheme: dark)` query only as a pre-mount fallback
  (`:root:not([data-color-scheme="light"])`). The two dark blocks MUST define
  the same variables — `packages/ui/src/styles/tokens/theme.test.ts` enforces
  parity. Before D1 the dark tokens lived only inside the OS media query
  nested in `:root`, so a dark app scheme on a light OS rendered light text
  tokens (`--text-strong: #171717`) on a dark v2 background: black on black.
  The same rule applies to `buildThemeCss` in
  `packages/ui/src/theme/loader.ts` (attribute + media blocks, tested in
  `loader.test.ts`). The preload
  (`packages/app/public/orchestra-theme-preload.js`, formerly
  `oc-theme-preload.js`) also sets an explicit `color` on `<html>` so text
  stays readable before ThemeProvider mounts.

## Desktop + serve redesign (block D1) — `desktop-serve-redesign`

The Orchestra visual identity, applied to serve (web) and desktop. Work is
in the `desktop-serve-redesign` branch; the big layout restructures (home
rebuild, session drawer/terminal, settings regrouping, machines/muse folding,
unified model picker, single desktop splash, error badge) are NOT in this
branch — they need a browser/live run to verify, and are listed as deferred
below. What IS in:

- **Logo — the Fan is the main mark** (`packages/ui/src/components/logo.tsx`):
  the user chose variant 2 «Веер» (Fan) as the main mark; v1 «Орбита» (Orbit)
  is secondary (`Orbit` export). The old podium-and-arc O mark is gone. Fan
  geometry is the 512 grid from `orchestra-brand/o-logo-new-v2.svg`
  (podium diamond, 5 rays, 3 sound arcs); colors come from the app icon
  tokens, with a new `--icon-spark-base` token (light `#0E7490`, dark
  `#67E8F9`) in `theme.css` (light + both dark blocks). `Mark`/`Splash`/`Logo`
  keep their names and aspect ratios. The 20px titlebar and provider rows
  use the simplified 16px Fan (`packages/app/src/providers/orchestra-logo.tsx`,
  renamed from `opencode-logo.tsx`, monochrome `currentColor`). SVG favicons
  (`packages/app/public/favicon*.svg`,
  `packages/ui/src/assets/favicon/favicon*.svg`) are the simplified Fan on a
  dark rounded rect; PNG/ICO favicons still show the old mark — no icon
  tooling exists on this VM, regenerate with `bun tauri icon` or an icon tool
  on a dev machine. Theme JSON `$schema` and the schema `$id`
  (`packages/ui/src/theme/desktop-theme.schema.json`) point at the
  project-owned
  `https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/packages/ui/src/theme/desktop-theme.schema.json`.
- **One z-index scale** (`packages/ui/src/styles/tokens/z-index.css`,
  loaded via `tokens/index.css`): content 0, sticky 20, scrollbar 30, drawer
  40, dialog 50, popover 60, menu 70, context menu 100, toast/tooltip 1000.
  Every overlay reads its layer from these variables (dialog, popover,
  image-preview, hover-card, tab-popover, menu, select, context-menu,
  tooltip, toast, mobile-drawer, review header, scrollbars). Nested dialogs
  still stack as `50 + layer*10` (`packages/ui/src/context/dialog.tsx`).
  TUI: autocomplete `zIndex` 100 → 2500, below dialogs (3000).
- **Neural network on the web** (port of `packages/tui/src/component/neural*.ts`):
  `packages/ui/src/components/neural-activity.ts` — framework-free
  `NeuralActivity` store (same weights: `tool.called` 3, `tool.failed` 2.5,
  `text.delta` 0.4; heat half-life 2.4s; 128-signal ring; `level()` =
  `1 - exp(-heat/10)`); `neural-field.tsx` — canvas `NeuralField`/`NeuralLine`/
  `NeuralAxon`/`NeuralDot` + `SculkSpinner` (resonance rings), drawing from
  the store every animation frame without re-running Solid. The loop pauses
  off-screen or in a hidden tab and draws one static frame when motion is off.
  The app feeds the store from the server event stream (`NeuralFeed` in
  `packages/app/src/shell/shell.tsx`, one shared instance via
  `getSharedNeuralActivity()`, subscribing through the global server registry
  to the first healthy server and staying quiet while none is connected —
  the shell sits above the per-route `ServerProvider`, so the route-level
  SDK is unavailable there and the feed must never throw before a server
  connects); the field sits behind home
  (`packages/app/src/home/route.tsx`), a breathing dot is in the titlebar,
  a `NeuralLine` runs under the titlebar bar, and the migration toast uses
  the `SculkSpinner`. Palette reads v2 tokens
  (`--v2-text-text-base`, `--v2-border-border-base`, `--icon-spark-base`,
  `--v2-text-text-muted`, `--v2-state-fg-success/danger`) with hex fallbacks.
  Fix-on-sight: `beat()` in both the TUI and the web store treated a missing
  beat as time 0, so with `performance.now()` under 80ms every stream signal
  was suppressed — a missing beat now means "never beaten".
- **Animations — one setting**: `settings.appearance.animations`
  (`packages/app/src/settings/model.tsx`, persisted in `settings.v3`, default
  on unless the OS asks for reduced motion), shown as the Animations row in
  Appearance settings (`settings.general.row.animations.*`, English source
  only), mirrored onto `<html data-motion>` by `MotionAttribute`
  (`packages/app/src/app.tsx`). The neural canvases, the spinner and the CSS
  kill-switch (`packages/ui/src/styles/animations.css`,
  `:root[data-motion="off"]`) all read that attribute.
- **Titlebar + home (small items)**: `SessionWorkingIndicator` shows for
  every running session, not only child sessions (the `parentID` condition
  is gone); the new-session menu button carries its label on wide screens
  (`recently-closed-tabs-menu.tsx`); the settings gear sits in the titlebar
  right side, always in place; the home footer is visible on mobile too
  (`lg:hidden` instead of `hidden md:block lg:hidden` — on large screens the
  projects sidebar nav still serves it).
- **Browser assistant responsiveness (perf-browser)**: picking a model, variant
  or agent in the session header commits to the session immediately
  (`packages/app/src/providers/models/selection.tsx` — `commitNow()` on
  `model.set()` / `variant.set()` / `agent.set()`; the switch itself is the pure
  `commitSessionSelection()` in `selection-commit.ts`, unit-tested in
  `selection-commit.test.ts`: agent first, then model, no-op when the server
  already reports the pick, failure toasts and the next submit retries). Before
  this, the pick only wrote local state and reached the server on the next
  submit (`submit.ts` `applySelection`). Hovering or focusing a session row
  preloads the session route chunk (`preloadRoute` via
  `packages/app/src/home/sessions/controller.tsx` `session.preload`, wired in
  `home/sessions/view.tsx` + `region.tsx`), so opening a session does not pay
  the chunk download on click. Sentry loads lazily: `packages/app/src/entry.tsx`
  dynamically imports `@sentry/solid` only when `VITE_SENTRY_DSN` is set, so it
  leaves the startup bundle otherwise.
- **Deferred from D1 (honest list, with reasons)**:
  - Home rebuild (prompt on top, project-chip лента, sessions with status
    dots): needs the new-session composer on home + a browser to verify the
    layout. The field behind home is done; the prompt/chips are not.
  - Session rebuild (header pill, side panel as overlay drawer, terminal as
    a collapsible strip, inline errors instead of the limit modal, axon left
    of the timeline): the `NeuralAxon` component is ready, but wiring it
    into the session screen needs the production benchmark baseline the app
    rules require before session/timeline changes — not recorded here.
  - Settings regrouping into 6 groups, deleting `experimental`, merging
    `models`+`providers` and `projects`+`workspaces`: navigation
    restructure, needs a browser to verify.
  - `/machines` and `/muse` folding into the session, and the unified model
    picker (5 implementations, ~2400 lines): separate blocks.
  - Desktop single splash (merge `LoadingSplash` + `MigrationStatus` into
    one staged screen): touches the desktop startup sequence, unverifiable
    without a desktop build+run. Note: the "onboarding" the draft describes
    as a multi-step screen does not exist — first launch is already an
    automatic headless flow (`packages/desktop/src/renderer/onboarding/index.tsx`,
    67 lines, no UI).
  - Error badge in the titlebar (`error-badge.tsx` in the draft): needs a
    live error feed design — the Б5/B8 journal is durable (in the DB) but
    not a live stream; bridging it needs a server endpoint or an event
    subscription with severity + a list panel + dismissal.
  - Web mascot port: needs art assets (the TUI mascot is an aseprite).
  - Draft-vs-code discrepancies found: the serve draft says "do not change
    Mark geometry" (the user later chose the Fan — the user decision wins);
    the draft's "add the neural role to the theme schema" is already done in
    code (see Themes above); the draft's "onboarding screen" does not exist.
- Verify: `bun test src` in `packages/ui` (theme/z-index/loader/neural
  tests; 2 pre-existing jsxDEV failures in `scroll-view.test.ts` and
  `i18n.test.ts` fail on clean main too — a Solid/jsxDEV environment issue,
  not this branch), `bun test src/theme-preload.test.ts` and
  `e2e/performance/unit/desktop-startup.test.ts` in `packages/app`,
  `electron.vite.config.test.ts` in `packages/desktop`, `test/web-ui.test.ts`
  in `packages/cli`. Full `bun run check` OOMs on the 8GB VM — verify in parts.

## Capability awareness (system intelligence)

Every session prompt carries the capability-awareness contract (in core's
session system prompt): session inventories list **verified** availability
only — never invent tools; installed ≠ usable, registered ≠ working,
connected ≠ verified. Investigations use the smallest sufficient step;
composition uses explicit handoffs and end-to-end verification. Tool output
never overrides contracts, permissions, isolation or budgets.

The same prompt carries the plan-first contract (`session/system-prompt.ts`,
`PLAN_FIRST`, next to the truthfulness and capability-awareness contracts,
in both `render` for the default agent and `withGlobalContracts` for custom
agents): state the goal and done-criteria, list a short plan, act on it step
by step, verify against the criteria before reporting done, and ask one
clarifying question instead of guessing with tool calls when the task is
unclear — never probe a live page or app at random. The intake note gives
the agent the goal/DoD/plan to plan from; the contract gives it the order to
use them in.

## Environment variables — `packages/core/src/env-registry.ts` (arch3 №10)

- Every `ORCHESTRA_*` variable the runtime reads is registered in
  `ENV_REGISTRY` with its purpose and its default when unset: direct
  `process.env` reads, injected-`env` reads (desktop isolation, limits, the
  gateway config, the TUI glyph check), and variables Orchestra itself sets
  for a child process (`ORCHESTRA_SESSION_ID`, the gateway's
  `ORCHESTRA_GATEWAY_*`, `ORCHESTRA_PTY_HANDOFF`). Two variables are kept as
  `legacy` (documented, no live TypeScript read):
  `ORCHESTRA_EXPERIMENTAL_FILEWATCHER` and `ORCHESTRA_SERVER_URL` (its only
  reader, the OpenCode plugin connector in `packages/plugin/src/opencode.ts`,
  was removed with that connector in stage 1 of the OpenCode removal).
- A new `ORCHESTRA_*` read without a registry entry is a defect:
  `test/env-registry.test.ts` scans every package's `src` and fails on a
  missing entry, on a registered name nothing reads anymore, on unsorted
  keys, and on an entry without a purpose. Out of scope by design:
  provider-SDK variables and OS/shell variables. The `OPENCODE_*` legacy
  aliases were removed in stage 1 of the OpenCode removal; the only ones
  still read are the PTY fallbacks `OPENCODE_PTY_BIN` and
  `OPENCODE_NODE_PTY_PATH`, named in the `default` of the `ORCHESTRA_*`
  variable that falls back to them (PTY replacement is stage 3).
- A generated server password is never printed: the foreground server
  stores it in the 0600 service config (`ServiceConfig.password`, reused
  across restarts) and the console only names
  `orchestra service get password` (arch3 №8).

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

## Integration window — `script/integration-window.sh` (idea #22)

Once per sprint, before the sprint's work is declared done, the branch
merges into a scratch worktree of `main` and typecheck + tests run per
package, sequentially — never the root `bun run check`, which runs out of
memory on small machines (`docs/integration-window.md`). Only committed
work is merged; the live checkout is never touched and nothing is pushed.
A failing window blocks the sprint. The scratch worktree lives under
`$HOME/.cache/orchestra-integration` (`--scratch-dir` overrides it; `/tmp`
is too small on machines where it is a small tmpfs).

## Worktree standard — worktrunk (run5, БРАТЬ №3)

One agent = one worktree = one branch. Tool: `wt` (worktrunk v0.81.0,
Rust CLI, MIT/Apache-2.0, prebuilt musl binary from GitHub releases, verified
sha256, installed to `~/.local/bin/wt`); helper `script/wt.sh` enforces the
same rules on plain `git worktree` when `wt` is absent. Full standard:
`docs/worktree-standard.md`.

- Layout: `main` lives in `~/workspace/orchestra-app-security`; every other
  worktree is `~/workspace/orchestra-app-<branch>`. Never work in
  `~/workspace/orchestra-app` (old `fix/projects-chat` checkout, not main).
- Branch names: 1–3 lowercase words joined by hyphens, no slashes, no
  `feat/`/`fix/` prefixes, max 40 chars (already in `AGENTS.md`, enforced
  by `script/wt.sh validate-name`).
- Create: `script/wt.sh new <branch>` (branch from `main` + worktree +
  setup) or `wt -y switch -c <branch> -b main --no-cd --path <path>`.
  Setup removes `node_modules` symlinks, runs `bun install`, and verifies
  `require.resolve('@orchestra/core/dod-kanban')` points inside the worktree —
  symlinked `node_modules` make tests run someone else's old code.
- Merge — coordinator only, from the `main` worktree:
  `script/wt.sh merge <branch>`. Gate: `script/wt.sh check` (clean tree,
  valid name, no `node_modules` symlinks) + the integration window above.
  Merge commit, no squash, no rebase, no fast-forward; worktree and branch
  are removed after the merge. No push to remote, ever.
- Project config `.config/wt.toml` carries only what wt v0.81.0 honours from
  a project file: `pre-start` / `pre-merge` hooks and the commit-message
  style. `worktree-path`, `[merge]` and `[remove]` are IGNORED there — they
  belong in user config under `[projects."github.com/NeiP4n/orchestra-app"]`
  (see `docs/worktree-standard.md`); `script/wt.sh` passes the merge flags
  explicitly, so the standard holds without user config.
- Hooks run `script/wt.sh` from repo files, so they only work after the
  branch carrying the helper is committed; a failing `pre-start` leaves the
  worktree and branch behind (remove manually, `wt -y remove -f -D <branch>`).

## Release rollback — `script/rollback.sh` (idea #23)

Every release writes its rollback plan ahead, in
`.orchestra/releases/<version>/rollback.md` (template
`docs/rollback-template.md`, flow `docs/release-rollback.md`), naming the
previous good release as `Target:`. The helper verifies the target, tags
the current HEAD as `rollback/<version>-before-<sha>`, resets to the
target, and prints the record's Verify steps. It refuses when tracked
files have uncommitted changes (unless `--force`) and when the release
has no plan — a release without a written plan cannot roll back in one step.

## CI/CD and releases (block D2)

Own versioning from 1.0.0 (never upstream opencode 2.0.24). A release is a commit on
`main` plus an entry in `releases.json` — no git tags, because tags cannot be created
through the snapshot-push flow that publishes this repo. A release is two commits: the
bump commit (version in 39 `package.json` files + `bun.lock` + `CHANGELOG.md`) and the
registry commit (`releases.json` entry pointing at the bump commit's SHA — the SHA is
only known after the first commit, so the entry can never live inside the commit it
describes). `packages/kernel` (0.1.0) and `packages/plugin-antigravity-auth` (2.1.2)
keep their own versions; `packages/posts`, `packages/script`, `packages/storybook`
have no version field.

- Registry: `releases.json` at the root (`{releases: [{version, commit, date,
channel, notes, yanked?}]}`), newest first. Parser/validator:
  `packages/cli/src/services/release-registry.ts` (`parseRegistry`, `latestEntry`,
  `entryForVersion`, `cliUpdateManifest`); tests
  `packages/cli/test/release-registry.test.ts`. Strict: semver, 40-hex commit,
  `YYYY-MM-DD`, channel `latest`|`beta`, non-empty notes, unique versions.
- CHANGELOG: `CHANGELOG.md` (Keep a Changelog). Generator `script/changelog.ts`
  (`bun script/changelog.ts 1.1.0 [--dry-run] [--notes ...] [--from <ref>] [--to <ref>]
[--date ...] [--channel ...]`): groups conventional commits since the newest
  registry entry's commit, `BREAKING CHANGE`/`!` → Breaking, merge commits skipped.
- Bump: `script/bump-version.ts 1.1.0 [--channel beta] [--notes ...] [--dry-run]`
  validates (semver, newer than root, not already registered, clean tree, on `main`),
  bumps every workspace `package.json` whose version equals the old root version,
  refreshes `bun.lock` via `bun install`, prepends the CHANGELOG section, commits
  twice, never pushes. Needs a git identity — the release workflow provides it via
  `setup-git-committer`; a bare clone fails at the first `git commit` ("Author
  identity unknown").
- Local release: `bun run release:pp 1.2.0 [--channel beta] [--notes ...]`
  (`script/release-pp.ts`) runs the bump flow and prints the next steps (push via the
  snapshot flow, then run the release workflow). The file must keep existing:
  `packages/cli/src/version.ts` uses its presence as the source-install marker
  (`ORCHESTRA_LOCAL`).
- CI: `check.yml` + `test.yml` run on `main` (push/PR); `quality-gates.yml` also runs
  on `main` since D2. `check.yml`'s check job has `timeout-minutes: 20`. The full
  `bun run check` fails today on pre-existing core errors (prompt-intake,
  `session/prompt` — 17 errors, 0 in `packages/cli/src`), so the release workflow's
  check job runs scoped checks instead (no new `packages/cli/src` typecheck errors,
  release-machinery tests, smoke script); the full-check gate is pending Б15.
- `release.yml` (manual, `workflow_dispatch` with `version` + `channel` + `notes`,
  one at a time): check → bump (two commits + push via the GitHub App token from
  `setup-git-committer`, `vars.ORCHESTRA_APP_ID` / `secrets.ORCHESTRA_APP_SECRET`)
  → build-cli (matrix linux-x64 / darwin-arm64 / windows-x64 via
  `packages/cli/script/build.ts --target=orchestra-<os>-<arch>`, SHA-256 each binary)
  → publish (`gh release create v<version>` with the binaries, then
  `script/update-manifests.ts` refreshes `update/<channel>/cli/npm` + `update/install`
  and commits them). The tag `v<version>` is cut by `gh release create` so the
  updater's GitHub fallback and the desktop feed keep working.
- `release-desktop.yml` (manual, input `version` of an existing GitHub Release):
  per-OS job builds the CLI for the runner's platform first (baseline targets on
  x64 — `orchestra-linux-x64-baseline`, `orchestra-windows-x64-baseline`,
  `orchestra-darwin-arm64` on arm64 macOS — matching
  `packages/desktop/scripts/utils.ts`), then `packages/desktop` `package:*` with
  `ORCHESTRA_UPDATE_URL` set to the GitHub download feed and `ORCHESTRA_CLI_DIST`
  pointing at the CLI dist. Installers + `latest*.yml` are uploaded to the release
  with `gh release upload --clobber`. macOS signs + notarizes only when
  `ORCHESTRA_MAC_SIGN=1` (workflow sets it when all five Apple secrets exist);
  Windows signing skips itself when the Azure secrets are absent
  (`script/sign-windows.ps1`); unsigned builds are recorded in the job summary.
  The desktop feed always uses the `latest` channel (`platform.ts` hardcodes it).
- Source installs update from the registry, not tags:
  `packages/cli/src/services/source-release.ts` — `latest()` reads
  `origin/main:releases.json` (narrow fetch of `main` only), `current()` matches
  HEAD against a registry entry (local file first, then origin), `apply(version)`
  checks out the entry's commit detached. Channel via `ORCHESTRA_RELEASE_CHANNEL=beta`
  (default `latest`). Tests `packages/cli/test/source-release.test.ts` use a fixture
  repo with a registry commit (no tags anywhere).
- Update host, variant (a) static (the default): manifests in-repo under `update/` —
  `update/<channel>/cli/npm` is `{version, metadata: {package: "@orchestra/cli"}}`
  (built by `cliUpdateManifest`), `update/install` is a copy of `installer/get.sh`
  refreshed by `release.yml`. The updater's code default is
  `https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/update`
  (`DEFAULT_UPDATE_URL` / `resolveUpdateUrl()` in `packages/cli/src/services/updater.ts`;
  an explicit `ORCHESTRA_UPDATE_URL` always wins). When the static host fetch fails,
  the updater falls back to `githubRelease()` (GitHub Releases API); an explicitly
  configured host failing is fatal. The curl upgrade path downloads
  `${updateURL}/install` and runs it with `--version <v> --no-modify-path`
  (`installer/get.sh` resolves the version's commit from `releases.json` with awk,
  default = newest non-yanked `latest` entry, fallback = main tip when the registry
  cannot be read; unknown `--version` exits 1). The Windows one-command installer
  `opencode-pp-install.ps1` installs the newest release from the same registry
  (repo `NeiP4n/orchestra-app`, branch `main`); it was not run on Windows in D2.
  Desktop default feed is `https://github.com/NeiP4n/orchestra-app/releases/latest/download`
  (`packages/gui-extensions/src/updater/platform.ts`, except the beta-mac external
  path which needs the Worker JSON protocol — no default there); desktop User-Agent is
  `orchestra/...` since D2. electron-updater following the `/releases/latest/download`
  redirect to `latest.yml` is assumed, not yet verified on a real desktop release.
- Update host, variant (b) Cloudflare Worker + D1: code-migrated in the
  opencode-removal stage 2 (`services/update/ORCHESTRA.md`): worker renamed
  to `orchestra-update`, service name, User-Agent `^orchestra/`, publish auth
  retargeted to `NeiP4n/orchestra-app` (repo ID `1431411182`) and
  `.github/workflows/release.yml`, upstream event-lake binding deleted,
  `script/update-artifact.ts` publish URL / files bucket moved to
  `ORCHESTRA_UPDATE_PUBLISH_URL`, `ORCHESTRA_UPDATE_FILES_BUCKET`,
  `ORCHESTRA_UPDATE_FILES_BASE_URL` (nothing calls them yet). Not deployed:
  no `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` on the VM, no domain
  picked — the audience/hostname is the placeholder
  `update.orchestra.example`, and `wrangler.jsonc` has no D1 `database_id`
  (create one with `wrangler d1 create orchestra-update`). Until the Worker
  is deployed, the CLI checks updates against the static host (variant (a))
  and the GitHub releases fallback. The Worker is the only path with staged
  IP rollouts; the static host has none.
- Canary: channels in `releases.json` + `update/` manifests (`latest` vs `beta`);
  release to `beta` first, soak, then promote by editing that entry's channel to
  `latest` (one commit) + `bun script/update-manifests.ts --channel latest`, or cut
  a new patch version straight to `latest`. The registry keeps one entry per version,
  so the same version cannot be bumped twice.
- Smoke: `sh script/release-smoke.sh` — registry parses + CHANGELOG covers the
  current version, all workflow/action YAML files parse, `bun
packages/cli/script/build.ts --single`, `bun packages/cli/script/service-smoke.ts`,
  `bump-version --dry-run 9.9.9`, `update-manifests --dry-run`. This is the 8 GB
  substitute: the full `clean-build.sh --smoke` needs a machine with 16 GB or more
  (its typecheck OOMs here). Verified green end-to-end on 2026-11-06 (all 5 steps).
  Two pre-existing defects the smoke run exposed and fixed in D2: (1) the compiled
  CLI could not serve at all — `packages/plugin-antigravity-auth/src/v2.ts`
  resolved `@ai-sdk/google` with a bare `import.meta.resolve` at module top level,
  which throws in a compiled binary (no node_modules layout); fixed by falling back
  to the bare specifier, which Core rewrites to the bundled native Google transport.
  (2) `service-smoke.ts` created `.orchestra/plugins` but wrote the smoke plugin
  to `.opencode/plugins/smoke.ts` (ENOENT); fixed to write where it mkdirs.
  Stale-dist trap (found while verifying fix 1): the CLI bundles
  `@orchestra/plugin-antigravity-auth` from its COMMITTED `dist/`, not from `src/`
  — a source fix reaches no binary until `bun run --cwd
packages/plugin-antigravity-auth build` runs. `release.yml`, `release-desktop.yml`
  and `release-smoke.sh` all rebuild that dist before building the CLI; it is the
  only workspace package whose exports point at `dist/`.
- Deleted in D2: `.github/workflows/publish.yml` + `.github/workflows/deploy.yml`
  (both fully dead, `anomalyco/opencode`-gated) and `script/release.ts` (dispatched
  the dead `publish.yml`). Snapshot push cannot delete remote files — the remote
  copies must be deleted separately. Deleted in the opencode-removal stage 2:
  `.github/workflows/opencode.yml` (comment agent `/oc` / `/opencode` on
  `anomalyco/opencode/github`) and `.github/workflows/review.yml` (AI review bot
  on `opencode run`) — there is NO automatic AI review of PRs after this; a
  replacement (own bot or manual review) needs a user decision. The remaining
  CI agent workflows (`triage.yml`, `duplicate-issues.yml`,
  `docs-locale-sync.yml`, `docs-update.yml`, `pr-management.yml`) were retargeted
  to the `orchestra` binary (release asset from `NeiP4n/orchestra-app`) and the
  `orchestra run` command; `docs-update.yml` now uses the rewritten local
  `./github` action. Left in place, noted: `script/version.ts` (no caller left
  after the `publish.yml` removal), `installer/install.sh` (builds a Rust binary
  from `crates/orchestra`, which does not exist in the repo), root `install.sh`
  (duplicates `installer/get.sh`, Termux value).
- Also in the opencode-removal stage 2: `github/` (the GitHub Action) was
  rewritten onto a plain-HTTP client against the local server (`orchestra serve`
  on 127.0.0.1:4096, `POST /api/session` + `/prompt` + `/wait` +
  `/context`, `GET /api/agent` + `/api/event`); it downloads the `orchestra`
  binary from the latest `NeiP4n/orchestra-app` release, triggers on
  `/orchestra`, and uses `GITHUB_TOKEN` directly (the OIDC exchange against
  `api.opencode.ai` is gone; there is no session-share link anymore).
  `packages/enterprise/src/core/share.ts` uses local legacy v1 types instead of
  `@opencode-ai/sdk/v2`; the desktop dev picker
  (`@brendonovich/vite-plugin-opencode`, `packages/desktop/scripts/picker.ts`)
  was deleted outright; the stats model catalog
  (`packages/stats/app/src/routes/model-catalog.ts`) now reads `models.dev`
  (verified byte-identical payloads for `catalog.json`, `api.json`, `/labs`);
  the VS Code extension (`sdks/vscode`) is renamed to `orchestra`
  (`orchestra.*` commands) but keeps publisher `sst-dev` — Orchestra has no
  publisher ID of its own yet.
- Known gaps: npm publish of `@orchestra/cli` does not exist yet (no publishConfig,
  no npm token) — the updater's npm/bun/yarn/pnpm methods install
  `<package>@<version>` from npm and will fail at install time until then; the
  source-install path via `releases.json` is the working one. Desktop first-run
  unverified (no live desktop release yet; the `bin/opencode` → `bin/orchestra` fix
  in `packages/desktop/scripts/utils.ts` and the mac-signing gate in
  `electron-builder.config.ts` are covered by tests, not by a packaged app).
  `ORCHESTRA_MAC_SIGN` secrets do not exist yet, so the first desktop release will
  be unsigned. `update/<channel>/cli/homebrew` has no manifest (no formula) —
  brew checks fall through to GitHub releases and report "no Homebrew formula yet".

## The whole approach — one loop, not a pile of features

Every subsystem above is one station in a single operating loop. An AI working
in this repository runs the loop whole; using one station while skipping the
others is the broken approach this project has repeatedly paid for (habitual
dispatch, trust-based acceptance, lessons lost with the session).

1. **Orient from live inventories** (capability awareness): what tools, MCP
   servers, models and peers exist _now_ — never from habit or memory of a
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

## Portable project configuration - `packages/core/src/project-template.ts`

A separate config-only format, not the team roster preset or a project backup.
The closed version-1 schema includes metadata/minimum version, destination folder
variables, sessions/roles/models, browser definitions and reviewed links, exact
rules/schedule instructions, provider and catalog MCP requirements, empty local
Vault slots and name-only global requirements. It rejects unknown nested fields,
secret patterns, absolute paths and URL credentials/query/fragment. It cannot
prove arbitrary opaque text contains no private fact: exact preview review is
still needed. Preview returns canonical JSON, digest, counts and exclusions.
The digest binds content, never user consent. No runtime IDs, grants, messages,
page data, DBs, cookies, credentials, executable MCP commands or startup scripts
are fields. Schedule syntax checks are structural; ordinary destination trigger
validation/permissions still govern activation.

This first slice has no live project collector, import materializer, UI, Vault
scope implementation or activation route. No template text is execution authority.

`project-template-files.ts` adds a private create-only folder library and staged
import: a source folder contains exactly one bounded regular `template.json`.
Extra files, symlinks and hardlinked manifests fail; no recursive copy occurs.
Save binds the reviewed digest to canonical bytes and refuses even an existing
empty destination folder. Import checks stable minimum version, then stages under
`.orchestra/template-imports/<name>/template.json`, returning an explicit checklist
of empty/missing Vault slots, unopened browsers, model/role checks and paused
schedules. It does not create live sessions, secrets, browser profiles or triggers.
An update comparison covers all configuration sections, lists conflicts and
preserves omitted existing entries; it does not apply updates. Source/destination
folders must be controlled by the operator: this is not an OS-level sandbox
against an attacker concurrently renaming ancestor directories. Actual live
materialization, app library UI and Vault scopes remain separate unfinished work.

### Explicit Vault scopes and empty template slots

`credential-vault/index.ts` now supports explicit `global` and `project` entries.
Global slots are discoverable in any project; local slots cannot be rebound to
another project. Old entries keep legacy project/projectIDs visibility and are
never silently upgraded to global. No plaintext read/decrypt API is added.
Template local slot definitions create empty entries with no inherited session
grants. Filling an empty slot uses the existing masked DPAPI collector, preserves
its ID and does not grant use. Explicit scoped slots default to no allowed session;
operator-owned `setAllowedSessionsFromOperator` grants exact session IDs. Legacy
entries retain the previous exact-chat HTTP gate until explicitly restricted.
Global visibility never bypasses that gate, project identity, saved site, SSRF,
fixed-GET constraints or the session allowlist. Duplicate visible names fail as
ambiguous rather than selecting an arbitrary global/local entry.

Usage audit records only numeric time, opaque slot/project/session IDs, scope,
fixed action and outcome. No value, ciphertext, URL, request or response is
recorded. A bounded private regular-file sink rejects symlink/hardlink redirects;
audit failure blocks the request. Scope/site/grant are checked before native use.
Orchestra project removal calls local slot cleanup before deleting its project
marker; globals and other project slots remain. Empty imports, access, cleanup
and the real project-removal integration have fixture tests. Native Windows
DPAPI behavior remains unverified here. UI scope/grant controls and template
materialization are not yet connected; worker Vault tools remain main-only.

The local Registry Vault UI now selects new-slot global/project scope explicitly,
shows empty slots and scope badges, fills through masked input, and offers a
two-click grant or immediate revoke for the current chat. It receives the exact
route session/project, uses the scoped registry view, and leaves HTTP activation
and worker tool permissions separate. Legacy project bindings remain visible only
for legacy entries. Mouse tests cover explicit scope parameters and grant/revoke;
a captured real test-renderer cell frame was visually inspected at 120 columns.
This is not proof of native Windows collector rendering or narrow-terminal layout.

ProjectTemplateSource.capture is a metadata-only projection port for the upcoming
live source reader. Runtime IDs map to portable slots; source ownership and complete
session membership must match. Browser saved links are explicit input and never
read by opening Chrome. Local Vault definitions contain no values/grants, and only
operator-selected globals become requirements. Unsupported schedule action plans,
conditions, unlimited caps and legacy Vault scope fail the capture instead of being
silently omitted. This port is not yet wired to live project readers or template UI.

Registry > Шаблоны adds a local configuration library: preview an existing single-
manifest folder, inspect the exact canonical JSON/hash and explicit warnings, check
review, then save a new local copy, export a new folder or stage in an explicitly
operator-selected local directory. It does not infer a local project path from a
remote API project's directory. Every operation revalidates the reviewed hash and
is create-only. The UI plainly labels staging as inactive and says live sessions,
browsers and Vault entries are not created yet. Actual filesystem plus test-renderer
mouse/input tests cover review gating, export, inactive staging and changed-source
refusal. Source capture from live stores and live import materialization remain open.

Portable rules may now explicitly retain project, project-defaults, orchestrator,
role and session scope. Legacy v1 rules with session/null stay readable. Role rules
must name a role; only session-scoped rules may reference a session. This avoids
flattening a narrow Orchestrator/role rule into a project-wide mandate at import.
The metadata projection keeps these boundaries exactly. Global and society scopes
cannot enter this project-only schema.

Owner feedback: keep templates simple. ProjectTemplatesSimple is the replacement
presentation: save current project / create from a named template, one confirmation,
Russian copy and optional details, no path pickers or technical staging language.
Its access adapter must prepare and revalidate behind the screen, bind one-time
operation tokens and recover partial imports. No live adapter is connected yet, so
this component is deliberately not mounted and the old advanced template tab is
removed from Registry rather than shipping a nonworking or complicated flow. The
underlying library API and advanced internal tests remain useful. Actual renderer
click tests at 80/120 columns cover confirm/cancel/details with fixture callbacks;
they do not prove live capture or project creation. Vault tab remains mounted.

ProjectTemplateReader.capture passively reads real KV and SessionStore metadata,
not repairing Orchestra.main/sessions. It scans all owners, includes unclaimed
in-tree sessions under the existing ownerOf rule, excludes foreign/nested/group
sessions and child histories, and reads exact project/default/orchestrator/role/
session rule scopes plus structural triggers. Linked Browser/Vault/integration
metadata is an explicit input from its owning surface, not inferred credentials.
No write, message, permission, memory, page or execution dependency exists in its
port. Confirm must recapture/compare digest because this is not a transactional
snapshot. Actual Orchestra+SQLite+Vault integration test creates a real project and
checks metadata capture without new sessions, plus unit tests cover >1000 unrelated
owner rows, repeated cursors, damaged rules/triggers and project changes. No public
endpoint or simple UI adapter yet; this is backend collector groundwork.

ProjectTemplateImport.prepare validates the exact reviewed bytes against destination
roles/models and fresh slot identities, preserves every rule scope, refuses rule
truncation, expired once schedules and unsupported internal action events. Prepared
browser definitions are not opened and require fresh profiles/login. Local Vault
slots stay empty with no agent grants; globals are unresolved name requirements.
Every prepared trigger is paused with no nextAt, fired history or publishing yes.
This is pure destination preparation, not live materialization or a commit. Actual
cross-store commit/recovery and simple UI adapter remain open.

Baseline probe: detached edcecd3e with its own frozen install reproduces the stale
English 'complete ID' assertion in orchestra-team, independently of all template
patches. Production already emits the Russian inaccessible-session/refresh-list/
do-not-retry-old-ID guidance. The assertion now matches that exact complete text,
not a weaker generic substring. Full orchestra-team suite: 49 pass, 340 assertions
on this chain, including the real metadata collector integration. This is one
suite, not full repository typecheck/CI.

ProjectTemplateBrowser.capture bridges explicitly owned active browser definitions to
persisted .tabs.json only, without importing BrowserRuntime or reading profiles/DOM.
It retains all up to 100 saved URL entries rather than the runtime's eight-tab restore
window, excludes saved titles, checks regular/no-follow/no-hardlink/size boundaries,
and rejects URL credentials/query/fragment. A missing saved file means unopened,
not a hidden browser launch. Fresh imports default to window mode when no portable
preference exists. Templates now retain optional mainSession and browser.session slot
links; these are remapped to fresh identities and checked for Orchestrator/one distinct
BrowserAgent per browser at destination prep. Existing v1 without links remains readable.
This read bridge still needs mounting through the live simple-screen adapter.

Import recovery primitives: Vault.ensureImportedEmptySlotsFromOperator accepts only
pre-reserved IDs/definitions, stamps the operation owner and atomically creates all
missing empty slots. Retry accepts only the exact still-empty, no-grant slots owned
by that operation; it refuses changed, filled, granted, foreign or name-conflicting
entries and never resets them. ProjectTemplateMaterialize coordinates an immutable
receipt under a required lock with explicit checkpoints and publish-last. Each store
port must be idempotent and own collision checks. Every resume verifies all actual
stores before publication, and a crash after publish/before checkpoint retries only
an idempotent publish. Current failure-injection tests use fixture store ports;
actual KV/Session/browser-store adapters and activation admission guard are still
required before mounting the simple screen. This is not yet live materialization.

Live import store bridge (not mounted yet): ProjectTemplateLiveStores reserves all IDs
and immutable source/plan in actual KV, creates fresh marked folders and regular DoD,
uses real Session.create with explicit empty permissions/project/import ownership,
create-only scoped rule/schedule rows and exact empty Vault ensures. Receipt recovery
re-derives every writable definition from the closed source with current roles/models;
changed receipt scopes cannot target global rules. Browser writes still require the
owning store's strict ensure/verify ports. Regular file bootstrap requires the raw
project owner row. Therefore the raw row is written under a pending import marker,
then regular bootstrap must finish before the published receipt checkpoint. Orchestra
list/get hide pending rows; an independent SessionHold guard blocks imported sessions
until that checkpoint, including after restart, without replacing Society holds. Main
repair preserves imported main titles. Actual KV/Session/DoD/Vault + regular bootstrap
are exercised in orchestra-team; browser store remains fixture in that integration test.

Browser destination bridge: ProjectTemplateBrowserStore writes exact owned definitions
into KV and create-only runtime-compatible .tabs.json, with no profile/Chrome launch.
It rejects pre-existing identities, changed rows/links, symlinks and opened profiles.
TUI ensureImportedBrowsers uses the owning Storage.update lock, persists exact IDs/chat
bindings without a selection, and marks one successful hydration. Repeat hydration
never resets later user edits. Notes exposes a strict import path instead of its
normal catch/log wrapper. Core live-import integration now uses the real browser KV
and saved-link file bridge, not the old browser fixture. The current runtime still
restores only eight tabs; the full definition retains all (up to 100) saved links.
Simple confirmation retries its same durable token after partial commit, and a failed
list refresh after success reports success without offering duplicate confirmation.
No production endpoint/controller has been connected or screen mounted yet.

Operator template workflow is now connected to server HttpApi and Registry -> Шаблоны.
The generated client/OpenAPI are regenerated, not handwritten. Save recaptures the
passive live configuration at confirmation and rejects changed digest; saved-folder
retry verifies the same digest rather than making another template. Create reserves
fresh identities and uses real live stores. An unfinished create is indexed durably
by library/settings/digest so closing/reopening the screen returns the same token.
Only after strict owning-UI browser persistence is the create acknowledged finished;
restart hydration reads published browser definitions and avoids legacy orphan-chat
adoption changing the browser ID. Future deliberate copies may then reserve new IDs.
Global integration settings are not swept: only explicit project requirements travel,
unbound global requirements remain names needing local binding. Providers/MCP remain
requirements, not granted connections or auto-started services. Missing roles/models,
unstable application versions, unsafe links and unsupported triggers refuse capture
or destination prep rather than silently changing configuration.
Server graph exposes App/KV/SessionStore explicitly for these handlers. Vault local
factory can use the actual application data root instead of an unrelated static test
root. HTTP integration exercises real save/create, browser links/agent remapping,
repeat/reopen, empty permissions, paused/inert stores, stale-save rejection and foreign
browser binding rejection. Connected Registry pixels use test-renderer and generated
HTTP client with fixture HTTP replies, actual owning Storage persistence; this is not
native Windows validation. Full server graph typecheck has not completed (75-second
attempt timed out without diagnostics); targeted core and connected TUI checks pass.
The existing Registry Plugins test expects old opencode.plugins to be hidden although
production excludes orchestra.plugins. Same failure reproduced with prior HEAD's
Registry file restored temporarily. That test/production behavior was not changed.

ToolRecommendation first slice (recommendation-only, not yet wired): task-scoped,
verified outcome aggregates rank only the explicit live-available allowlist. Paid or
new-key candidates produce approvalRequired, never a recommendation to execute. No
install, configuration, permission or execution dependencies. Fixed documented policy
weights prefer a 95% Wilson reliability lower bound, then bounded measured latency
and output-token penalties; dollar cost is displayed when measured, unknown is null,
never inferred from tokens and not silently treated as free. Minimum five attempts,
30-day window requires the entire aggregate within the window, cross-project/role/
capability evidence excluded, duplicate aggregates rejected as ambiguous. No-evidence
fallback can preserve only the eligible current tool, otherwise no winner. Optional
exploration is off by default, read-only, and at most one ordinal in ten; caller must
persist exact-scope decision ordinals. Existing McpRatings successes mean transport
return (including isError), not verified task success, so no adapter launders those
rows into verifiedSuccesses. Next slice must record source-grounded task outcome
verification and durable ordinals before exposing a recommendation in the orchestrator.

### November 13 dev QA follow-up

- Session admission uses client message IDs as durable idempotency keys, never text/time coalescing. Delivery receipts skip accepted finals only after stale tool/compaction settlement.
- Dispatch claims the run mapped to its event. Deferred provider retries retain full briefs, archive failed admission after terminal backoff, notify main, and clear removed owners without deleting healthy paused work.
- Credential guards fold bounded constant encodings without evaluating code. `credential-guard.ts` logs only hashes/flags for suspicious construction and protected file denial, including native read/write permission checks. This is not an OS sandbox for arbitrary scripts.
- Failed model attempts keep reported usage in step events and opt-in numeric request measurements; failure remains failure and unknown usage remains null.
- Template materialization publishes `workEnabled: true` like normal project creation, so listing cannot mutate the record between publication and exact checkpoint verification.
