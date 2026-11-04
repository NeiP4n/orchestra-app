# Repairs — Forensic Audit V2

## F-LOC-1 — location catalog sync is best-effort
- `packages/client/src/solid/data.ts`: `location.sync` fan-out changed from
  `Promise.all` to `Promise.allSettled`, with a comment stating the contract:
  `syncInfo` (location identity) is the only fatal check.
- `packages/tui/src/context/data.tsx`: the wrapper's
  `Promise.all([location.sync, config.sync])` became `Promise.allSettled`;
  `syncInfo` is still awaited first and still rejects.
- Regression test: `packages/client/test/solid-data.test.ts` —
  "location sync tolerates failing catalogs but not a failing location
  identity". Fails on unfixed code (1 fail), passes fixed; full file 30/30.

## F-MCP-1 — MCP budgets enforced at dispatch
- `packages/core/src/mcp/budget.ts` (new): stamp parsing (fail-closed on
  malformed), persisted-usage parsing, and the synchronous gate
  (allowlist → total → per-server → reserve). Header documents the semantics:
  attempts count and are never refunded; reserve contains no await, so racing
  parallel calls cannot both take the last slot; epochs identify tasks;
  restarts resume from KV write-through.
- `packages/core/src/mcp/index.ts`: `MCP.callTool` consults the gate after
  server resolution, before dispatch; denial returns `ToolCallError` with the
  gate's message. Layer gained `SessionStore.node` + `KV.node` dependencies
  (both depend only on `Database.node`; no cycle).
- `packages/core/src/tool/plugin/orchestra.ts`: the stamp now carries a fresh
  `budgetEpoch: crypto.randomUUID()` per hand-out; the comment that previously
  implied dispatch enforcement (before it existed) now describes both real
  layers accurately.
- Tests: `packages/core/test/mcp-budget.test.ts` (13 unit tests: parsing,
  fail-closed, allowlist non-consumption, total/per-server caps, session
  independence, epoch reset, persisted resume). `packages/core/test/mcp.test.ts`
  gained a "MCP budget enforcement at dispatch" block (3 tests through the real
  dispatcher against an in-process HTTP MCP server; sessions seeded via a new
  `seed` override in the `resourceMcpLayer` fixture, executed inside the layer
  scope where its Database is reachable) and SessionStore/KV/Database
  provisions for the new layer dependencies. On the unfixed dispatcher, 2 of
  the 3 integration tests fail; the unit gate tests target the new module.
- Related suites still green: orchestrator-limits + ai-standard + mcp-budget
  = 40/40.

## Not repaired (documented instead)
- F-GEN-1 (stale openapi.json): regeneration diff on clean main is +1301/−95 of
  unrelated protocol content; belongs in its own commit.
- Typed 503 translation for location defects: implemented, measured (server
  typecheck 117 errors vs 11 baseline), reverted. See RESIDUAL_RISKS.md.
