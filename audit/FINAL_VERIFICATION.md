# Final Verification — dynamic templates, session MCP assignments, and two live-bug fixes

Date: 2026-11-04. Base: `main` @ `9ffabbd`. Delivered directly to `main`
(Richard's explicit instruction for this mission). Solo sequential work;
the application was never run standalone in the sandbox.

## What shipped

1. **Dynamic templates** — `full`, `factory`, `pro-engineers`,
   `proof-driven` removed from the chooser and preserved as legacy records;
   the remaining 15 built-ins rewritten as dynamic playbooks with `roles`
   recommendations; built-in projects open only the Orchestrator (workers
   are created lazily), operator-saved templates keep their exact rosters.
   See `TEMPLATE_CLEANUP.md`, `DYNAMIC_TEMPLATE_DESIGN.md`.
2. **Dream Team retired** — plugin deleted; its evidence gate lives on as
   `OrchestraStage.verifyAcceptance` + the `sessions` action `verify`.
   See `DREAM_TEAM_RETIREMENT.md`.
3. **MCP lifecycle ported to main** from the `mcp-lifecycle-autonomy-ui`
   branch (it was never merged): lifecycle service, `mcp_manager` tool,
   default-off migration, its tests.
4. **Per-session MCP assignments** — every dispatch stamps
   `orchestra:mcp-assignment`; the sidebar shows THIS SESSION and TEAM MCP
   ASSIGNMENTS (Orchestrator only, own project only). See
   `SESSION_MCP_ASSIGNMENTS.md`, `TEAM_MCP_SIDEBAR.md`,
   `SIDEBAR_SIMPLIFICATION.md`.
5. **Skills/commands modernized** — autonomous-developer, project-creator,
   mcp skill texts; command-forge examples (`typo` model removed,
   `workflow`/`subagent` rewritten dynamically); Orchestrator prompt's
   factory block replaced with the dynamic workflow.
6. **Live bug fix — every location load 500s**: Richard's server log showed
   `GET /api/provider` dying with `providers.available().map is not a
   function` at `packages/server/src/handlers/provider.ts:26`.
   `Provider.Service.available()` returns an Effect; the handler called
   `.map` on it. The handler now yields the effect before mapping (the
   pattern `plugin/host.ts` already used). This was the concrete defect
   behind the long-standing "500 for every directory" failure.
7. **Live bug fix — background service never discoverable on Windows**:
   Richard's registration file contained `http://0.0.0.0:49375` with a live
   pid while `ensure()` spawned five contenders and timed out. A LAN-open
   service binds the wildcard address and advertised it verbatim; 0.0.0.0
   is a bind address, not a connect address, and Windows refuses
   connections to it (Linux/macOS route it to loopback, which is why this
   never reproduced off Windows). Registration now advertises loopback for
   wildcard binds (`packages/cli/src/services/service-registration.ts`),
   and the client probe/PTY handoff normalize a wildcard registration URL
   to loopback (`connectURL` in `packages/client/src/service-probe.ts`),
   which also repairs discovery of already-running services.

## Tests actually executed (worktree, from package directories)

- schema `test/orchestra.test.ts` — **11/11**.
- core `stage-verify` + `mcp-assignment` + `orchestra-role-quality` +
  `orchestra-factory-verification` + `orchestra-stage` — **69/69**.
- core `mcp-lifecycle` + `mcp-acquire` + `mcp-budget` — **41/41**.
- core `orchestra-team.test.ts` — **40/40** (clean main also 40/40; the
  suite's setups were adapted to lazy worker creation via
  `orchestra.createMember`, the same API the Orchestrator uses).
- core `plot.test.ts` — **4/5**; the symlink-storage test fails
  identically on clean main (pre-existing, unrelated).
- core `instruction-guidance` + `snippet` + `tool-dod-integration` — pass.
- tui `sidebar-mcp-model` — **8/8**; tui `theme-contrast` — **2/2** (every
  built-in theme, every mode, readable pairs). See
  `TEXT_VISIBILITY_VERIFICATION.md`.
- theme package suite — **5/5**.
- client `service` + `service-reconnect` + `service-contender-pool` —
  **42/42**; client `service-decision` (incl. new `connectURL` cases) —
  **4/4**.
- server `test/orchestra.test.ts` — the rewritten template test **passes**
  (built-in opens only the Orchestrator; saved template opens its roster;
  retired id rejected); the file's other test times out at 5 s in this
  sandbox **identically on clean main** (pre-existing).

## Typechecks (`bun typecheck` per package)

- schema, theme, protocol, client: **clean**.
- core: **8 errors**, all pre-existing baseline files (`muse-chat.ts` ×7,
  `tool/plugin/orchestra.ts` ×1 — the documented baseline was 11 including
  dream-team's 3, now removed). No errors in changed files.
- tui: no errors in TUI files; only the core baseline set via project
  references.
- server: 113 errors dominated by pre-existing test-harness typing
  failures across untouched files (`room.test.ts` ×37, `fetch.test.ts`
  ×14, …); the changed handler is not in the error set.
- cli: 13 errors, all in pre-existing files (core `muse-chat.ts` ×7, core
  `tool/plugin/orchestra.ts` ×1, server `handlers/pty.ts` ×3, cli
  `src/index.ts` ×1, cli `test/web-ui.test.ts` ×1) — **zero in the changed
  registration file**.

## Client generation

`bun run generate` in `packages/client` regenerated the effect/promise
clients for the `TemplateSpec.roles` field and the updated protocol
descriptions; generated files are part of this delivery and were not
hand-edited.

## Known limitations

- The TUI's client `McpServer` type exposes only `{name, status}` — no
  tools-discovered flag — so sidebar rows show connection state, not tool
  discovery. Per-task budget spend lives in core KV and is not exposed via
  the client API, so the sidebar shows assignments and caps, not live
  usage counters. Nothing was invented to fill these gaps.
- The server handler fix (item 6) is covered by code inspection and the
  location fan-out behaviour in the live server suite; there is no
  dedicated `/api/provider` handler test in the repo's harness style.
- Richard's machine verification is still his: after pulling main, the
  app should start (registration becomes `http://127.0.0.1:…`) and
  location loads should stop returning the provider 500.
