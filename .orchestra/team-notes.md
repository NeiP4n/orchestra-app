# Team notes

Durable facts about working in this fork. Keep short and factual.

## Core edge cases (аудит L-019)

- `it.effect` в `packages/core/test/lib/effect.ts` работает на `TestClock`: `Effect.sleep(...)` внутри теста не завершится без `TestClock.adjust`, тест просто висит до 30s-таймаута. Для перекрытия фиберов использовать `Effect.yieldNow`.
- `Orchestra.contains` из `@orchestra/schema/orchestra` не нормализует регистр Windows (`C:/Proj` против `c:/proj/sub` -> false), в отличие от `@orchestra/util/path.containsDirectory` и `FSUtil.contains`. Используется в правах инструментов (read/grep/glob/room-rules/sandbox) и federation — ложный отказ при расхождении регистра. `containsDirectory` в `@orchestra/util/path` теперь гарантированно раскрывает `..` через `comparablePath`, канонизирует пути через `realpathSync.native` (раскрывая короткие DOS 8.3 имена и Windows junctions), нормализует любые бэкслэши и отсекает traversal escapes.
- `Project.resolve` канонизирует директорию через `@orchestra/util/fs-util` (resolve -> realpath), ID = hash(`directory:<canonical>`), поэтому один каталог в разной записи (регистр, слеши, `..`, MSYS `/c/...`) даёт один projectID. `database/path.ts` сам путь не нормализует — в `ProjectTable.worktree` писать только канонические значения.
- `KeyedMutex` освобождает ключ при прерывании и дефекте держателя; 25 конкурентных `withLock` на одном ключе дают peak=1 и `size===0` (тесты в `test/effect/keyed-mutex.test.ts`).
- Завершение шелл-команд на Windows (`packages/core/src/shell.ts`): стандартный `child.kill()` оставляет процессы-зомби из порожденных дочерних процессов; `killProcessTree` завершает всё дерево процессов через `taskkill.exe /pid <pid> /T /F` при таймауте, удалении команды и остановке сервиса.

## TUI checks and red tests

- `bun script/lint-changed.ts HEAD` does not cover `packages/tui` at all (its scope is `packages/app`, `desktop`, `gui-extensions`, `ui`, `session-ui`), so it prints "no changed TypeScript files" for a tui-only diff. Lint tui files with `bunx oxlint <files>` from `packages/tui` instead.
- `packages/tui/test/project-tree.test.tsx` › "the orchestrator council mode button saves the group mode when clicked" is red at HEAD (5s timeout) before any Council redesign: it drives the inline `Orchestrator council` toggle in the groups dialog. Verify a failure against `git checkout --` of the touched files before blaming your change. The Council redesign replaced that toggle with the `Edit` form (Mode chips + Save), so this test needs rewriting to that flow.
- Render-component scratch checks: keep the provider stack from `packages/tui/test/component/dialog-groups.test.tsx` (`ConfigProvider` → `Keymap` → `ToastProvider` → `RouteProvider` → `ClientProvider` → `ProjectsProvider` → `ThemeProvider` → `ArgsProvider` → `DataProvider` → `LocationProvider` → `PermissionProvider`); dropping `ArgsProvider` makes the dialog hang without a frame.

## App e2e harness

- Adding an HttpApi endpoint to `packages/app/e2e/utils/mock-api.ts` also needs a handler in `e2e/utils/mock-server.ts` (`mockHandlers`): `HttpApiBuilder.group` requires every endpoint, and an unanswered `/api/**` call fails the test with `Unmocked API request` (501).
- `bun typecheck` in `packages/app` excludes `e2e/`; run `bun typecheck:e2e` for the specs. It currently fails on pre-existing errors in `e2e/performance/**` and `e2e/regression/timeline-stream.spec.ts`, so compare only the errors naming your files.
- The app e2e suite needs Playwright build 1217 (`chromium_headless_shell-1217`); other builds in `%LOCALAPPDATA%\ms-playwright` belong to other projects. Install with `bunx playwright install chromium` from `packages/app`.
- `bun script/lint-changed.ts HEAD` lints only the working-tree diff and enforces the anti-slop rules (conditional empty-object spreads, readable blank lines); plain `bun run lint` scans the whole repo.
- Playwright wipes `e2e/test-results` and the HTML report at the start of every run, so copy `error-context.md`/traces out of the failing run before re-running a spec; afterwards the failure is unrecoverable.
- The "Edit server" dialog in `home.spec.ts` verifies the typed password while the field changes: flip the mock's accepted password (`accepted.password`) BEFORE `fill`, otherwise the verify can leave with the new password while the mock still accepts the old one (401 -> editor keeps stale credentials, dialog never closes). Proven from a trace: fill 48.053 -> GET /api/info with the new password 48.111 -> 401.
- `home.spec.ts` must wait for the session route (`toHaveURL(sessionHref(...))` + header heading) after "Back to app": the settings surface detaches before the route settles, and the next header click otherwise races the back navigation (occurred once as a 30s `locator.click` timeout with the app left on Home).
- The session-project-menu cases in `home.spec.ts` carry explicit budgets: `test.setTimeout(STRESS_CASE_TIMEOUT = 120_000)` plus `const check = expect.configure({ timeout: STRESS_ASSERTION_TIMEOUT = 30_000 })`. The suite default is 10s per assertion and that is the limit that breaks first on a loaded runner (settings surface render), not the 60s per-test default. With 12 CPU burners the whole file takes 2.0m and those cases still take 4-12s each, so judge a new failure by its assertion, not by the clock.

## Home live check (dev app)

- The "Create AI team" button only renders in the single-server branch of the projects panel (`view.tsx`: `props.servers.length === 1`). Adding a second server in the dev app hides it, so a live check must run with exactly one visible server.
- A freshly launched `bun dev` app (packages/app, port 4444) is a clean profile: Settings → tab "Сервер" → "Добавить сервер" → "Use password" (URL `http://127.0.0.1:<port>`, password from `orchestra service get password`). The built-in `localhost:4096` entry cannot be removed or hidden from the UI.
- The app's language is ru in this profile, so UI labels are Russian while new feature copy (e.g. "Create AI team") stays English until translations land.
- A long-running `orchestra service` answers with the code it loaded at start: check `(Get-CimInstance Win32_Process -Filter "ProcessId = <pid>").CreationDate` and `GET /openapi.json` (built from the loaded HttpApi) before trusting it has a fresh commit. On 31.10.2026 the 49375 service started 12:07, before `53b4994` (20:16), and its `society.create` body listed only name/goal/directory.
- To keep one visible server in the dev app, start vite with `VITE_ORCHESTRA_SERVER_HOST`/`VITE_ORCHESTRA_SERVER_PORT` equal to the stored server URL: `resolveServerList` dedupes by key, while a different URL plus the provided `localhost:4096` makes two servers and hides the "Create AI team" button.
- Creating a Society from the dialog now registers the Society's projects in the Home panel: `ai-team-dialog.tsx` reads `orchestra.group.list()` (matched by `supervisor === society.sessionID`) plus `orchestra.project.list()` and calls `addProjects`. Before that fix the panel only listed `home.project.list()`, which nothing wrote.
- The app aborts any API request that waits >60s for response headers (`packages/app/src/runtime/server/request-queue.ts`, `requestHeadersTimeoutMs`); `POST /api/worktree` and `POST /api/orchestra/society` get the 10-minute setup budget (`isSetupRequest`). `POST /api/orchestra/society` with a team template builds two projects and nine sessions, so on a loaded server it outlived 60s and the abort left a planner folder/project behind with no group (observed 31.10.2026; fixed by adding the path to `isSetupRequest`). The queue's `log` payload is typed `RequestQueueLog`, which also cleared the old `Record<string, unknown>` anti-slop finding in that file and its test.
- `Orchestra.create` reconciles main tasks by taking the dispatch lock of every task on the server (`reconcileMainTasks`); on a busy service (28 running sessions) a single project create can stall for many minutes. The 62383 service on 31.10.2026 created only `<society>/планировщик` and its main session and never reached the group or the team project.

- `Orchestra.create` used to reconcile main tasks on every creation, which scanned every task on the server; on a busy service (28 running sessions) one project create stalled for minutes and never reached the group or the team project (62383 service, 31.10.2026). Now `ensureMainUnlocked` reconciles only when a previous main is gone (`project.main !== undefined && !existing`), the pass considers only markers this project claims, and a busy dispatch lock is skipped instead of awaited (`KeyedMutex.tryWithLock`).
- `dispatchLocks` lives at module scope in `packages/core/src/orchestra.ts` (exported), not inside the service: dispatch ownership is process-wide, and tests hold a real lock through `Orchestra.dispatchLocks.withLock(id)`.
- `bun test` in `packages/core` used to lose 63 tests to bun's 5s per-test default (`formatter`, `federation`, `orchestra-team`, `session-runner`). `packages/core/test/preload.ts` now calls `setDefaultTimeout(30_000)`; bunfig's `[test]` has no `timeout` key (Bun reads `--timeout` from the CLI only), so `packages/core/bunfig.toml` keeps a comment instead of a silently ignored entry. `bun test test/federation.test.ts` went from 6-9 five-second timeouts to 25 pass / 0 fail in 90s. The `federation` + `session-execution` files also fail when run together at HEAD (24 fails), so treat cross-file hangs there as pre-existing.

## Worker models and the Feature shortlist

- `Orchestra.workerFavorites` reads the root config key `model_favorites` (the TUI Feature tab, `provider/model` without a variant) and hands parsed `Model.Ref`s to `Orchestra.workerModels(policy, role, { favorites, catalog })`. With a non-empty shortlist the pins decide the primary model; role model, role list, category policy and general policy stay as deeper fallbacks. Depth roles (regex `plan|architect|review|strateg|analys|audit|design|debug` over `category + name`) take the pinned model whose reasoning variant ranks highest and run it at that variant; other roles take the cheapest pinned model by the catalog's first price tier. A pinned `#variant` always wins, and a favorite whose model offers variants always gets one (a variant-less ref of such a model is not usable). Empty Feature = the old role/policy path, byte for byte.
- Both worker creation paths pass the shortlist: the `orchestra` tool `create` action (`packages/core/src/tool/plugin/orchestra.ts`) and `Federation.createSociety` (`packages/core/src/federation.ts`). Adding a third creation path means wiring `workerFavorites` there too, or it silently keeps the old defaults.
- The TUI settings dialog hides engineering noise: TPS is `advanced: true` (visible only with Developer mode on, `config.data.developer`), and the footer shows the default but no longer the internal config path (`settingID`).

## Delegation models

- A delegated task must name a reasoning variant when the model offers one: `#variant` in the model string or `Orchestra.RoleSpec.variant`. `resolveVariant` in `packages/core/src/tool/plugin/orchestra.ts` refuses an omitted or unknown variant with the available ids, and leaves variant-less models exactly as before. `Orchestra.modelOf` applies the role variant to the session model, with a variant written into the model string winning.

## Token budget

- `SessionStats.sessionBudget(messages, modelLimit?, { limits })` (`packages/core/src/session/stats.ts`) now also returns `spend: SessionStats.Budget` — requests/tokens/cost per base model (a `#variant` folds into its base model, since a variant changes the call, not the budget). A line gets `limit`/`remaining` only from `options.limits` (`provider/model` → tokens); the total carries `limit`/`remaining` only when every spending model has one, so a partial limit never reads as a full budget. `forecastBudget({ estimate, limit, used })` is the fitting arithmetic.
- The `budget` tool (`packages/core/src/tool/plugin/budget.ts`, registered in `plugin/internal.ts` `pre`, `codemode: false`) is read-only: `status` prints the session's spend per model, `forecast` compares a task (`task` text at 4 chars/token, or `tokens`) with the budget left. Allowances come from `budget`/`limits` inputs; without them forecast falls back to the model's catalog window (`limit.input` when > 0, else `limit.context`) and says so. Spend is cumulative for the session, so an allowance covers what it already burned on that model.

## Societies and worktree readiness

- `Federation.initRepository` runs `git init -q` and then `git commit --allow-empty -q -m "Initial commit"`, best effort: a host without git or without a configured identity ignores the failure, and so does a repository that already has commits. The empty commit gives the project a valid HEAD, which sandbox worktrees need.
- Quality and design roles (`ISOLATED_CATEGORIES` in `packages/core/src/orchestra.ts`, matched on the member category) get their chat location in `<project>/.orchestra/work/<role id>` so reports, dumps and scratch output never land among the project's files; build and general roles keep the project root, and a folder that cannot be created falls back to the root instead of failing team creation. Isolated sessions still show that folder in `_orchestra.move` results, because move rewrites every member location.

## Compaction thresholds

- `SessionPlan.CONTEXT_KEY` (`compaction_threshold`) accepts `"60%"`, a token count, and `{ percent, tokens }` (`type: "capped"`): `thresholdTokens` takes `min(share of the model window, tokens)`, and a `capped` value with no window answers the cap. `resolveSessionThreshold` in `session/compaction.ts` delegates the capped case to `SessionPlan.thresholdTokens`.
- `CompactionPolicy` (`packages/core/src/session/compaction-policy.ts`) is the per-role table: deep 80%/120k for analyst, product-analyst, architect, strategic-planner, researcher, deep-researcher, designer, reviewer, counterexample-engineer, security-auditor, compatibility-engineer and the project main session (`mainThreshold`); lean 50%/30k for tester, debugger, performance-engineer; everything else (and any role added later) keeps standard 60%/60k. A role is read by its `team-<role id>` agent, so a `PlannedTeamMember` (session id + agent) resolves too.
- `Orchestra.create` writes the threshold into session metadata when it creates the main session and every team member, and `reconcileTeam` retrofits a session whose metadata lacks the key — it never overwrites an existing value, because the operator and the `society_plan` tool own that dial.

## Work modes (TUI)

- `local.mode.list()` returns all 47 modes (13 builtins + 34 bundled jailbreak policies) and agents/sessions resolve a mode by the full `jailbreak:<policy>` id. Collapse only the display: `modeRows()` in `packages/tui/src/component/dialog-mode.tsx` drops the policy rows, and the single "Jailbreak" row opens `dialog-jailbreak.tsx` ("Automatic (fits the model)" + 34 policies). Never filter inside `local.mode.list()`.
- The mode picker is `tall`: on a 30-row test terminal only ~12 rows fit, so the last rows need scrolling/filtering before a test can click them.
- The sidebar's compaction default writes the server config through `config.update`; `saveDirectFallback` (orchestra.json) runs only after that call throws, and the toast reports success when either write landed. Covered by a real-behaviour test that keeps `XDG_CONFIG_HOME` on a temp dir and asserts the file stays untouched after a successful API write.
- In `test/sidebar-context.test.tsx` the sidebar's toast is read through a `ToastProbe` under a `ToastProvider` (there is no `<Toast />` in the tree, so frames are unchanged). Wait for the toast whose message carries the formatted threshold (`waitForDecision`): waiting for "any toast" reads the config file before the fallback write and fails only under full-suite load.

## TUI model picker

- Favorites live in `Config.Info.model_favorites` (`provider/model`, no `#variant`) and `Config.Patch.model_favorites` (null clears). A new config key needs three touch points or the write is silent: the `if ("<key>" in patch)` branch in `packages/core/src/config.ts`, `nativeAtomic` in `packages/core/src/config/normalize.ts` (otherwise the value is dropped on load), and `bun run generate` in `packages/client` (the generated client builds the PATCH body key by key).
- `dialog-model.tsx` reads favorites from `data.location.config` — the store is empty until `location.config.sync()` runs, so a test must sync it before opening the dialog — and writes them with `client.api.config.update({ model_favorites })` (PATCH `/api/experimental/config`, 204). The Feature section renders only while `useConnected()` sees an integration with connections, so a picker test must also mock `/api/integration`.
- `bun script/lint-changed.ts` lints only app/desktop/ui/session-ui paths and reports `0 of N` for tui, schema and core edits; run `bunx oxlint <changed files>` for those packages.

## CLI command tree

- A CLI command needs two places: `Spec.make("<name>", …)` in `packages/cli/src/commands/commands.ts` and the matching key in `Runtime.handlers(Commands, { … })` in `packages/cli/src/index.ts`; `Runtime.handlers` is keyed by the spec, so adding or deleting one without the other is a type error. Removing a command also means deleting its `handlers/<name>.ts` and that handler's test, and nothing else in the repo may still fetch the handler module (checked with grep for `handlers/<name>`).
- `bun typecheck` in `packages/core` is incremental (`tsgo -b`, state in `packages/core/node_modules/.ts-dist/*.tsbuildinfo`); a stale state can either hide errors in a newly added file or report them for code nobody touched. Delete that tsbuildinfo for a clean opinion before blaming a diff.

## Society folders

- Society and project folder names go through `Slug.folder` (`packages/core/src/slug.ts`): NFKD + mark stripping, Cyrillic transliteration (`ж → zh`, `щ → shch`, `ъ/ь → ""`), `[^a-z0-9._-]+ → "-"`, trailing dots dropped, Windows device names prefixed with `_`, 48-character cap, and `item-<hash>` when nothing usable remains. The four built-in projects keep Russian names but carry explicit ASCII `folder` ids (`planner`, `architects`, `coders`, `testers`) and `Federation.createSociety` passes them to `societyFolder`. An existing Society keeps the root stored in KV, so old Cyrillic paths stay valid; only new folders are ASCII.

## Agent tooling: fast checks and file maps

- `bun run check:fast` (`script/check.ts`) typechecks only the packages the working tree touched (`git status --porcelain` → `packages/<name>/`, any package with a `typecheck` script); a clean tree or `--all` checks schema, core, cli, tui, app. It runs in dependency layers (`schema`/`util`, then `core`, then the rest in parallel) because `tui` and `cli` build `core` themselves — running them concurrently with `core` races on core's tsbuildinfo. Output is one line per package (`core: typecheck OK (0.2s)`) and the failing layer's output with exit 1.
- `bun run map <file.ts> [--body 120-150]` (`script/map.ts`) prints at most 60 lines of top-level declarations with line numbers (`line: export function name(args)`), or an exact line range. Only column-0 declarations are listed, so a symbol nested in a namespace/class body needs `--body`.

## Desktop vision (`desktop_inspect`)

- `desktop_inspect` (actions `focused`, `screen`, `find`) reads Windows UI Automation through a long-lived PowerShell host built with `makeHost(INSPECT_PRELUDE, "desktop_inspect")` from `tool/plugin/desktop.ts`; the first call pays ~0.6-0.8 s for the process and Add-Type, later ones 0.2-0.3 s for `screen` and ~1.3 s worst case for a desktop-wide `find`.
- Coordinates are the control centre in real screen pixels (`SetProcessDPIAware`, UIA `BoundingRectangle`), so `desktop_click` needs `screen: true` with them. Elements whose centre falls outside the root element rect, offscreen elements, minimised windows (x/y ≈ -32000) and duplicate windows are dropped.
- UIA sees real Win32/UWP controls only: Electron/canvas apps (Discord, a web page in a browser) show their frame and `(no interactive controls)`, so a screenshot is still the only way inside one.
- The walk is bounded (6000 nodes / depth 8 for `focused` and `screen`; exact-name `FindAll` first for `find`, then a 1500-node / 1.2 s walk that starts at the focused window), and a miss that hit the bound says so instead of claiming the element does not exist.

## UI auditor (`ui-auditor`)

- `packages/core/src/ui-auditor.ts` is a pure text scanner (no parser, no dependencies): `auditUiCode(code, filename?)`, `auditUiDiff(patch)`, `formatAuditReport(violations)`.
- Rules: `no-raw-colors` (error) flags hex/`rgb()`/`rgba()`/`hsl()` only in a styling context (`style=`, `color:`/`background:`/`border:`/`fill:`/`stroke:`, Tailwind `[#...]`, or any line of a `.css` file); a styling keyword keeps that context open for the next 5 lines, which is what catches a gradient value on its own line. `semantic-tokens` (warning) flags a quoted CSS colour name (`color: "red"`). `no-emoji-spam` (warning) flags 2+ adjacent emoji units and `!!!`/`[!!!]`. `accessible-labels` (error) flags `<button>`/`<Button>` with no `aria-label`/`aria-labelledby`/`title`/`label`/`children` whose content is empty or only icon elements (`svg`, `Icon*`, `*Icon`); a content that is a design-system component is treated as unknown, not empty, and is not flagged.
- `auditUiDiff` reads only `+` lines, skips `---`/`+++`/`diff`/`index`, and numbers them by the `@@ ... +newStart` hunk so a finding matches the new file. A tag split across context and added lines is not judged.
- Baseline on the real tree: 367 `.tsx` files under `packages/app` + `packages/tui` produce exactly 2 findings, both true positives — the two `rgba(0,0,0,0.72)` mask gradients in `app/src/composer/dropzone.tsx:68,70`.

## Zen Browser bridge and tool (`zen_browser`)

- `packages/core/src/zen/bridge-server.ts` (`ZenBridgeServer`, singleton `zenBridgeServer` on `127.0.0.1:4097`): Bun.serve WebSocket server with HTTP fallback, lazy-started on first query/tool call; stores the active WebSocket connection from Zen Browser (`packages/zen-extension/src/rpc-client.ts`). Accepts `/status`, `/health`, `POST /heartbeat` (client/version tracking with 5s TTL), `GET /poll` (HTTP long-polling with 3s hold, 204 fallback), and `POST /result` (completes pending sendRpc). RPC pattern: sends `{ id, action, params }` over WS if open, else queues to long-poll; tracks pending requests with timeouts (10s default), cleans up and rejects on disconnection or stop. Handshake `{ type: "hello", client, version }` captures client info.
- `packages/core/src/tool/plugin/zen-browser.ts` (`zen_browser` core tool, registered in `internal.ts`): provides direct AI access to Zen Browser (actions `status`, `tabs`, `read`, `eval`, `click`, `type`, `navigate`, `activate`, `close`, `media`). If bridge is disconnected, returns graceful informative message (`Zen Browser bridge is running on port 4097, but no Zen Browser extension is currently connected...`). Output is formatted: structured list for `tabs`, metadata + text for `read`, eval value/JSON for `eval`, readable JSON for actions. Works transparently over both WebSocket and HTTP Long-Polling fallback.
- In tests, `ZenBridgeServer({ port: 0 })` can bind to an ephemeral port and be injected via `setZenBridgeServer(testServer)`, preventing port 4097 collisions.

## Self-healing loop (diagnostics)

- `packages/core/src/session/self-healing.ts` is a pure module: `parseDiagnostics` reads tsgo/tsc output (both `file(line,col): error TSxxxx` and `file:line:col - error TSxxxx`), bun failures (`error: expect(...)` + `Expected:`/`Received:` + `(fail) name` + stack), vitest (`FAIL file > name`, `AssertionError: expected X to be Y`), and runtime/syntax `error:` lines. TS1xxx codes classify as `syntax`, everything else as `typescript`.
- bun prints the assertion block before its `(fail) <test name>` line, so the name is merged into the pending test diagnostic; a failure therefore yields exactly one diagnostic with file, line, column, expected and actual.
- `summarize` clips at 2000 chars / 10 lines; `createHealingContext` allows a retry while `attempt < maxAttempts` and diagnostics exist, and sets `shouldRollback` (prompt names the checkpoint to restore) only when the budget is spent and a checkpoint id was given.
- Real integration checks: a failing `bun test` in a temp dir parsed as `math.test.ts:3:17 adds numbers (expected 3, received 2)`; `node_modules/.bin/tsgo.exe --ignoreConfig` on a broken temp file parsed both TS2322/TS2345 with locations. `bunx tsgo` does NOT work outside the repo (it tries the npm registry), use the local binary.

## Desktop action (`desktop_action`)

- `desktop_action` (`click|invoke|type|focus|media`) is a second long-lived PowerShell host (`makeHost(ACTION_PRELUDE, "desktop_action")`) so an action never queues behind a slow screen walk; media keys go through `bun:ffi` `user32.dll keybd_event` (no shell, no focus change).
- UWP windows (Calculator, Settings) are hosted by `ApplicationFrameHost`; the process name the operator knows lives on a child Window element of the frame. `Get-WindowProcess` walks one level down, so `app: "CalculatorApp"` matches and the report names the real process.
- `type` resolves the first writable Edit/Document in the window and uses `ValuePattern.SetValue` — verified on Notepad: text appears in both `ValuePattern` and `TextPattern` read-backs without touching focus. The clipboard-paste fallback taps Alt to unlock `SetForegroundWindow` and refuses to paste (`Could not bring ... to the front`) when the foreground check fails, so text never lands in another app.
- Click coordinates are real screen pixels (DPI-aware), so a click hits the centre of `BoundingRectangle`; `invoke` uses InvokePattern and falls back to Toggle/SelectionItem.

## Checkpoints (time machine)

- `checkpoint` core tool and `bun script/checkpoint.ts <save|list|preview|restore|delete|gc>` share `packages/core/src/checkpoint/` (`types`, `changes`, `store`, `engine`, `render`) — plain functions, no Effect, so the CLI runs without the runtime layers.
- A snapshot stores exactly the paths `git status --porcelain -z --untracked-files=all` reports (modified/added/untracked/deleted/renamed), nothing else: node_modules and build output are already ignored, and unchanged tracked files are already in git. Blobs are content-addressed (`Bun.hash`, xxHash64 hex) and zstd-compressed under `<project>/.orchestra/checkpoints/objects/<hash>.zst`; `index.json` is written temp-file + rename.
- `.orchestra/checkpoints/**` is filtered out of `readChanges`, so a project that does not gitignore `.orchestra` still never snapshots its own store.
- A restore compares each snapshot path with the tree first: unchanged paths are skipped, nothing is written if no object is missing, and the pre-restore tree is saved as `before-restore <moment id> <iso>` so the restore itself can be undone. Paths changed in the tree but absent from the snapshot are reported by `preview` and deliberately left alone.
- `delete` removes a snapshot; `gc` then removes objects no remaining snapshot references. Real measurement at the repo root (78 changed files): `save` took ~350 ms including bun startup, 1.3 MB → 377 KB.

## Code graph (CodeGraph)

- `bun script/codegraph.ts <search|explore|impact|index|stats> [name] [--root <dir>] [--depth N] [--limit N] [--force]` is the CLI over `packages/core/src/codegraph/`; the same code powers the `codegraph` core tool (actions `search`, `explore`, `impact`, `status`, `index`).
- The graph lives in `<project>/.orchestra/codegraph.db` (gitignored, WAL, FTS5 trigram over names). Full index of this monorepo: 5779 files → ~152k symbols / ~418k edges in 25-39 s; an unchanged second run is ~0.2 s. Auto-index happens only for projects with ≤400 files (`AUTO_INDEX_LIMIT` in `query.ts`), because building a big graph blocks the caller; larger projects must call `index` explicitly.
- `VERSION` in `indexer.ts` is the extractor generation: a DB written by another version is rebuilt from scratch on the next run. Bump it whenever `extract.ts`/`tokens.ts` change, or pass `--force`.
- Extraction: imports come from `new Bun.Transpiler({ loader }).scan()` (which drops `import type`), symbols and calls from the token lexer. Object-literal properties whose value carries a function body (`createSociety: Effect.fn(...)(function* () {})`) are indexed as methods — this repository defines most entry points that way; a property holding a call result (`sent: Date.now()`) is data and is not indexed. A call written outside every declaration is attributed to its file (`module` caller), which is how the HTTP handlers appear.
- Resolution is by name, deliberately: a call edge stores the callee's last segment, so `impact` refuses to expand a name declared more than 3 times (reported as `ambiguous`) and callers of very common names (`execute`, `group`, `run`) are approximate. Import edges resolve relative specifiers and `@orchestra/<pkg>/<path>` to repository paths, so `explore(...).importers` names real files.
- `packages/core/test/codegraph.test.ts` builds fixtures in temp folders (no git needed; the git path uses `git ls-files` with a walk fallback) and takes under a second.

## Core instruction tests

- `packages/core/test/instructions/builtins.test.ts` is red at HEAD: its expected text still carries the old `- A capability missing from this request -> tools, execute: …` line, while `src/instructions/guidance.ts` now advertises `tools: ["tools", "execute", "mcp_forge"]`. Bun reports the mismatch only inside the `<tool-routing>` block, so do not read it as a failure of your own instruction source.
- Built-in instructions are assembled in `InstructionBuiltIns.load` (`packages/core/src/instructions/builtins.ts`) and reach the runner through `session/context.ts` (`builtins.load(availableToolNames)` → `loaded.builtins`); there is no `loadInstructions` function and `instructions/index.ts` is the generic algebra only.

## Worker model routing (Smart Token Router)

- `ModelRouter.classify/route` (`packages/core/src/session/model-router.ts`) decides a worker's model and variant in `packages/core/src/tool/plugin/orchestra.ts`: `routeWorkerModel` (exported, pure) is called from the `choose` helper for both `send` and `create` when the tool call carries no explicit `model`. Candidates come from `Orchestra.workerModels` (Feature picks → role model → worker policy); routing is skipped for a role pinned with `model` and no `models`, for an empty catalog (`Model.Service` absent or no providers) and for empty task text.
- Classification reads the role as `id + category` only: role display names are prose, and a name like "Auditor" would otherwise score as an audit keyword. A role with its own `models` list keeps the variants written there; otherwise the tier picks the variant (`trivial: minimal/fast`, `standard: low/medium/fast`, `deep: high/max`).
- `tokens` passed to the router is `Token.estimate(task text)` — a lower bound of the request, so long-context pricing can only under-count, never over-count.

## Shared util helpers

- `errorMessage(error: unknown)` lives in `@orchestra/util/error` (and the new `@orchestra/util/index` barrel). It reads a string as is, an `Error.message` (falling back to its `name`), `message` on an Effect failure object, `data.message` when the failure nests it, then `String(value)` and finally the JSON of a plain object; `null`/`undefined` render as `"null"`/`"undefined"` and an unserializable object as `"unknown error"`. Prefer it over a new local copy in a package.
- `packages/util/test/global.test.ts` › "building a layer with default tmp creates and canonicalizes it" fails with `ENOENT ...\opencode-global-layer-*\tmp` at HEAD, with no working-tree changes — judge util test runs by the other files.

## Zen Browser Extension (`packages/zen-extension`)

- Extension bundle builds both entry points via `bun run build`: `src/background.ts -> background.js` and `src/sidebar.ts -> sidebar.js`. Do not leave raw TypeScript imports in root `.js` files.
- `ZenRpcClient` runs inside `background.js` and sends immediate HTTP heartbeat on `start()`, falling back between `127.0.0.1` and `localhost` with a 2000ms period (server TTL is 5000ms).
- `sidebar.js` sends direct heartbeat (`POST /heartbeat`) and checks `/status` every 2000ms to immediately establish and maintain `AI Bridge: Connected` state while the sidebar panel is open.
- Manifest permissions include `"alarms"` to keep the background event page alive in Gecko via 15-second alarm ticks.

## Commit boundaries (society-hold-mcp)

- `packages/tui/src/feature-plugins/sidebar/context.tsx` and `test/sidebar-context.test.tsx` still carry image-aware token estimation in the working tree (`IMAGE_TOKENS`, `measureOutput`, a 24-line `estimateToolTokens` test hunk). The compaction save/i18n work is committed (`dc96a9f`): the remaining diff of both files is only that image feature, so it can be committed as its own change without another split.
- `schema/src/config.ts` had a jailbreak field and a context-governor wording change in the same file; the jailbreak hunks went in with `7aa9124` (required by `core/src/config/normalize.ts`, `Info.fields.jailbreak`), the wording hunk is still uncommitted. Stage that file by hunk, never by file.
- `society.create` accepts an optional `team` template id only from `53b4994`; before it, the server silently dropped the field (Effect `Schema.Struct` strips excess properties — verified by decoding a payload with `team`), so the AI team dialog compiled but created a Society without its team project.

## TUI test suite baseline

- `bun test` in `packages/tui` is broadly red on `society-hold-mcp` (≈1754 pass / 168 fail / 24 errors), mostly `test/app-lifecycle.test.tsx` (e.g. it still expects a "Color mode" setting that no longer exists in `dialog-config.tsx` at HEAD) and `test/notes.test.tsx`. Verified with the Task B changes stashed: the same 4 notes tests fail without them, so do not chase these when working on modes.
- Full-suite counts swing run to run (31.10.2026: 1934 tests, 1795 pass / 12 skip / 127 fail / 5 errors; a parallel rerun already showed 153 fails mid-run), so judge a change by its own files: `bun test test/dialog-mode*.test.ts* test/context/local-mode.test.tsx test/sidebar-context.test.tsx test/dialog-config-categories.test.tsx` is green (24 pass) and stays green with the failures above.

## Antigravity auth plugin (vendored)

- `packages/plugin-antigravity-auth` keeps upstream's vitest suite (`src/**/*.test.ts` import `vitest` and `@opencode/plugin`), but this checkout installs neither: `bun test src/v2.test.ts` dies with `Cannot find module '@opencode/plugin'`. `bun run typecheck` works (tsgo, excludes tests). Verify changes here with typecheck plus a throwaway probe against the real account file, not `bun test`.
- Account pool state is `~/.config/opencode/antigravity-accounts.json`; per-model locks live in `rateLimitResetTimes` under `gemini-antigravity:<model id>` and a daily-quota 429 sets a reset up to days ahead. `fetchAvailableModels` returns no `remainingFraction` for an exhausted account.
- `AntigravityV2Plugin.canUseAccount` (v2.ts) filters the pool by the cached model catalog in plugin storage (key `model-catalog`), read once at setup. A long-running service therefore never learns about an account added by another process (`opencode auth login`): its snapshot lists N-1 accounts and the pool reports "All N-1 account(s) rate-limited" while the new account has full quota. Fixed by treating an account whose `addedAt` is newer than the snapshot as eligible; `PluginContext.canUseAccount` now receives `addedAt`.


## Antigravity account pool

- `packages/plugin-antigravity-auth` is vendored from upstream: its `src/**/*.test.ts` import `vitest` and `@opencode/plugin`, neither installed in this fork, so `bun test src/v2.test.ts` fails at import (`Cannot find module '@opencode/plugin'`). `bun run typecheck` (tsgo, excludes `*.test.ts`) is the working check there; verify behavior with a live probe instead.
- `v2.ts` filters the pool through `canUseAccount`, driven by the `model-catalog` KV snapshot built from `fetchAvailableModels`. That snapshot is read once in `setup`, so an account connected later by another process (e.g. `opencode auth login` in a short-lived CLI) stayed ineligible: the pool then reported "All N account(s) rate-limited" with a 17h+ wait while that account had ~100% quota. Fixed by treating an account whose `addedAt` is newer than the snapshot timestamp as eligible; `PluginContext.canUseAccount` now receives `addedAt`.
- Per-account quota lives in `~/.config/opencode/antigravity-accounts.json` (`rateLimitResetTimes["gemini-antigravity:<model>"]`). A daily 429 pins that model on that account for up to several days; the user-facing message quotes the smallest remaining wait across eligible accounts.
