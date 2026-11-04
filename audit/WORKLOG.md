# Worklog — Forensic Audit V2

## Execution constraints (owner decisions)
- NO parallel agent swarm: the owner previously ordered solo/sequential work after a
  9-agent swarm overloaded the platform and forced his reconnect. The six investigation
  tracks are executed sequentially by the lead engineer instead of six concurrent
  subagents. Deviation from the task text is deliberate and recorded here.
- Branch: `forensic-audit` from the verified remote default branch. No merge to main
  for this task; push the branch only.

## Phase 0 — Baseline (2026-11-04)
- Remote default branch VERIFIED via `git ls-remote --symref origin HEAD`:
  `refs/heads/main` (repo AGENTS.md claims `v2` — stale documentation; discrepancy noted).
- Base commit: 2e8fd85 (main after PR #33).
- Monorepo: 38 packages under packages/; Rust workspace: crates/orchestra,
  orchestra-kernel, orchestra-memory, orchestra-session.
- Canonical check: `bun run check` = check:decoupling + lint + typecheck (root package.json).
  Tests are never run from the repo root (project guard); per-package runs only.
- Pre-existing baselines (measured in earlier sessions on clean main):
  core typecheck = 11 errors (tool/plugin dream-team 3, muse-chat 7, orchestra 1);
  app typecheck = 2 errors (machines/route.tsx); known sandbox-flaky suites:
  rooms-dialog (network frames), command-selection (~7s vs 5s limit),
  session-move "defers an active move..." (fails identically on clean main).
- Working tree: isolated worktree ~/workspace/wt/forensic-audit; the main clone's
  local branch state (remove-warp) untouched.

## Already-confirmed defects entering this audit (owner's earlier audit list)
- F-ROOM-1 (HIGH, FIXED before audit, PR #31): room bans lost past 1000 KV entries.
- F-MCP-1 (CRITICAL, fix in progress): orchestrator MCP numeric budgets not enforced
  at dispatch. Implementation exists in worktree wt/mcp-budget-enforcement
  (budget gate + callTool wiring + budgetEpoch stamp); tests + integration move here.
- F-LOC-1 (HIGH, OPEN, owner's live bug): location sync returns bare HTTP 500 for
  EVERY directory on the owner's machine; TUI blocks typing behind the
  "Session location unavailable" recovery card although sessions run.
  PR #32 fixed the separate move-queue trap; the 500 itself is uninvestigated.

## Phase 1/2 — in progress
Next: F-LOC-1 root cause (server handlers in the location sync fan-out),
then the six investigation tracks in sequence.

## Phase 1–3 — Investigation and repairs (2026-11-04)
- F-LOC-1 CONFIRMED in code and FIXED (client fan-out + TUI wrapper now
  best-effort; regression test discriminates). Attempted server-side typed-503
  translation at the location middleware: implemented end-to-end (server
  middleware + protocol client twin + regenerated client, descriptors gained
  503), then REVERTED — server typecheck went from the 11-error clean baseline
  to 117 because the widened middleware error union breaks handler inference
  across ~30 files. Recorded in RESIDUAL_RISKS.md.
- F-GEN-1 CONFIRMED: openapi.json regenerates with +1301/−95 on clean main.
- F-MCP-1 COMPLETED here: implementation ported from the parked worktree
  (wt/mcp-budget-enforcement), 13 unit tests + 3 real-dispatch integration
  tests written; integration tests fail on the unfixed dispatcher.
  Seeding note: sessions are seeded through a new `seed` override in the
  resourceMcpLayer fixture, executed inside the layer scope — the fixture's
  Database is provided, not merged, so the test body cannot reach it
  ("Service not found: @orchestra/storage/Database" otherwise).
- Spot checks with no findings: room join auth gates; client import direction;
  check:decoupling PASS (6385 files).
- Verification: core typecheck 11 = baseline; client typecheck clean;
  client solid-data 30/30; core budget-related suites 40/40 + 3/3 integration.
- Environment lesson: worktree node_modules symlinked from the main clone make
  Bun resolve @orchestra/* into the MAIN clone (relative per-package links);
  this worktree's links were rebuilt as forests pointing at its own sources
  before trusting generation/typecheck results.
Next: final diff review, commits, push branch (no merge).

## Audit V3 (2026-11-04, branch audit-v3 from forensic-audit @ 8598160)
- Phase 1: budget gate redesigned — reservation is a single immediate DB
  transaction over the same KV row; corrupted usage now fails closed (V2
  treated it as zero); bounded cleanup (none-stamp delete + startup sweep).
  16 unit tests (incl. two-connection race on a real file DB) + 3 dispatch
  integration tests pass; core typecheck back to 11 baseline.
- Phase 2: defect logging in the location middleware (no error-union change);
  client catalog failures now logged by name. Owner's failing service still
  unidentified — needs his server log, which will now contain the cause.
- Phase 3: PTY outbox verified bounded (16 MiB / 8192 frames, 1013 resync);
  Rust crates read-only inspected (no toolchain in sandbox — not compiled);
  plugins and surfaces remain partial.
- Phase 4: openapi.json regenerated in dedicated commit 4fb6d3e after hunk
  analysis (delta fully legitimate, 0 operations removed); AGENTS.md default
  branch corrected v2 → main (verified via ls-remote).
Next: final checks, commits, push audit-v3.
