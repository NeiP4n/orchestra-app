# Master Findings — Forensic Audit V2

Execution note: the six investigation tracks were executed sequentially by the lead
engineer (the owner previously prohibited parallel agent swarms after a platform
overload incident; see WORKLOG.md). Coverage is therefore deep on the confirmed
defect paths and explicitly partial elsewhere (see COVERAGE_MATRIX.md).

## Confirmed defects

### F-LOC-1 — One failing location catalog locks the whole session (P2, FIXED)
- Component: packages/client (solid data layer), packages/tui (data context).
- Evidence: `createData().location.sync` fanned out to 12 per-location catalog
  endpoints with `Promise.all`; the TUI wrapper added `config.sync` the same way.
  Any single rejection propagated to the TUI `LocationProvider`, which marks the
  location "unavailable"; the session screen then replaces the composer with the
  "Session location unavailable" recovery card and typing is blocked.
- Owner impact (live, Windows): every directory he opened — a git worktree, the
  app folder, a plain temp directory — produced `UnexpectedStatus: 500` and a
  soft-locked session, while the sessions themselves kept running server-side.
  At least one catalog endpoint fails globally on his machine (a network/geo
  dependent catalog is the prime suspect; the exact server-side cause is in
  RESIDUAL_RISKS.md).
- Root cause: an all-or-nothing failure model for what is mostly cache-warming
  data. Event-driven refreshes in the same file already tolerate failures
  (`refresh()` catches and logs); only this sync path was fatal.
- Fix: the fan-out is best-effort (`Promise.allSettled`) in
  `packages/client/src/solid/data.ts` and `packages/tui/src/context/data.tsx`.
  Only the identity check (`location.get` via `syncInfo`) still rejects, which
  is what "location unavailable" means. Regression test in
  `packages/client/test/solid-data.test.ts` (fails on unfixed code, passes fixed).

### F-MCP-1 — Orchestrator MCP numeric budgets never enforced at dispatch (P1, FIXED)
- Component: packages/core (mcp, tool/plugin/orchestra).
- Evidence (owner's earlier audit, re-verified): `resolveMcpLimit()` computed
  `maxCalls` / `perServer` / allowlist and stamped them on the worker session's
  metadata, and deny rules covered disallowed servers — but `MCP.callTool`
  never counted calls, so a worker could exceed caps on allowed servers without
  limit.
- Fix: a budget gate (`packages/core/src/mcp/budget.ts`) consulted synchronously
  inside `MCP.callTool` after server resolution and before dispatch: allowlist →
  total cap → per-server cap → atomic reserve (no await between check and
  increment) → dispatch. Attempts count and are never refunded; the stamp
  carries a fresh `budgetEpoch` per hand-out (new epoch = new task = counters
  restart); usage is written through to KV per reservation and rehydrated after
  a restart when the epoch matches (documented gap: a crash between reservation
  and the KV write can lose in-flight counts); a malformed stamp fails closed;
  unstamped sessions are ungated.
- Tests: `packages/core/test/mcp-budget.test.ts` (13 gate/parse tests) and a
  dispatch integration block in `packages/core/test/mcp.test.ts` driving real
  `callTool` against an in-process HTTP MCP server (cap enforced, denials never
  reach the server, unstamped sessions unaffected). Integration tests fail on
  the unfixed dispatcher (2 of 3; the ungated-session test passes trivially).

### F-ROOM-1 — LAN room bans silently truncated at 1000 KV rows (P1, FIXED before this audit)
- Component: packages/core (room.ts). `Room.bans()`/`banned()` used a single
  `kv.scan` page (limit 1000) while bans are unbounded over a room's life, so
  older bans stopped being recognized by the join gate and `Room.remove()` left
  orphaned ban rows. Fixed in PR #31 (squash 32baac9) with a paginating scan and
  a regression test seeding 1001 bans. Recorded here for inventory completeness.

### F-GEN-1 — Committed `packages/protocol/openapi.json` is stale (P3, OPEN)
- Evidence: running the protocol's own generator (`bun run generate` in
  packages/protocol) on a CLEAN checkout of main (2e8fd85) already produces a
  diff of +1301/−95 — real protocol content (e.g. `Mcp.StreamableHttpConfig`
  schema refs, `x-opencode-ticket` header parameters) merged without
  regenerating. `check:generated` cannot pass on main as committed.
- Not fixed in this branch: regenerating would absorb ~1400 unrelated lines
  into an unrelated change. It should be regenerated in its own commit.

### F-DOC-1 — Default-branch documentation discrepancy (P4, OPEN)
- Repo AGENTS.md names `v2` as the default branch; `git ls-remote --symref
  origin HEAD` verifies `refs/heads/main`. Verified 2026-11-04; this audit's
  branch is based on `main`. Documentation should be corrected by the owner.

## Investigated, no defect confirmed
- LAN room join path (packages/server/src/handlers/room.ts): joining requires
  the host to set a server password (rooms refuse to be shared without one),
  join codes are checked and expire, guests are capped, the ban gate reads
  through the fixed pagination. No bypass found in a targeted read.
- Client dependency direction: `packages/client/src` contains no imports of
  `@orchestra/core` or `@orchestra/server`; `bun run check:decoupling` passes
  (6385 files scanned).
- Session execution drain: non-move drain failures are logged
  ("Failed to drain Session"); the move-specific trap was fixed in PR #32.
  No new repro found in scope of this pass.

## Architectural risks (not confirmed defects; owner decisions outstanding)
- zen-models refresh sends a real request to every free Zen model (concurrency
  4) with auto-fallback; freebuff provider subsystem; plugin-antigravity-auth
  spending Google Antigravity quotas; jailbreak prompt library (34 prompts).
  Flagged in the owner's earlier audit; he has not ordered removal. Untouched.
- Location-service defects still surface as bare HTTP 500s. An attempt in this
  audit to translate them into the typed `ServiceUnavailableError` at the
  location middleware (plus the protocol client twin and a regenerated client)
  was implemented and then reverted: widening the middleware error union broke
  handler type inference across the server package (117 typecheck errors vs an
  11-error clean baseline). See RESIDUAL_RISKS.md.
