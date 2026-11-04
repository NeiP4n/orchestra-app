# Test Results — Forensic Audit V2

All commands run in the audit worktree (packages run their own scripts; tests
never run from the repo root). Baselines were measured on clean main earlier
and re-confirmed where noted.

| Check | Where | Result |
| --- | --- | --- |
| Core typecheck (`bun typecheck`) | packages/core | 11 errors = clean-main baseline (all in tool/plugin dream-team/muse-chat/orchestra) |
| Client typecheck | packages/client | clean (exit 0) |
| Server typecheck (baseline probe) | /tmp clean checkout of main | 11 errors (same core plugin files via project references) |
| Server typecheck (with reverted middleware experiment) | audit worktree | 117 errors → change reverted; final branch does not touch server/protocol |
| Decoupling (`bun run check:decoupling`) | repo root script | PASS — 6385 files, no leaks |
| Client solid-data tests | packages/client | 30/30 pass, incl. new F-LOC-1 regression test |
| F-LOC-1 test on unfixed code | packages/client | 1 fail (discriminates correctly) |
| MCP budget unit tests | packages/core test/mcp-budget.test.ts | 13/13 pass |
| MCP dispatch integration (`-t budget`) | packages/core test/mcp.test.ts | 3/3 pass |
| Same, on unfixed dispatcher | packages/core | 2 fail / 1 pass (ungated-session test passes trivially) |
| orchestrator-limits + ai-standard + mcp-budget | packages/core | 40/40 pass |
| Protocol openapi regeneration probe | clean main checkout | diff +1301/−95 on a clean tree (F-GEN-1 evidence) |
| Client regeneration probe | packages/client | succeeds; descriptors gain 503 only with the (reverted) protocol change — final branch has no generated changes |

Known sandbox limitations (pre-existing, not caused by this branch): full
`test/mcp.test.ts` runs can OOM in this sandbox even on clean main, so MCP
tests were run with `-t` filters; TUI frame-based suites are timing-sensitive
here. The TUI itself was never run (owner prohibition on standalone runs).

## V3 (branch audit-v3)
| Check | Where | Result |
| --- | --- | --- |
| MCP budget tests (rewritten) | packages/core test/mcp-budget.test.ts | 16/16 pass — parse, decide, reserve, epoch replacement, corruption fail-closed, cleanup primitives, one-connection fiber race, two-connection file-DB race + resume |
| MCP dispatch integration (`-t budget`) | packages/core test/mcp.test.ts | 3/3 pass |
| orchestrator-limits + ai-standard + room | packages/core | 28/28 pass |
| Core typecheck | packages/core | 11 errors = clean-main baseline |
| Client solid-data tests | packages/client | 30/30 pass (with catalog failure logging) |
| Protocol check:generated | packages/protocol | PASS after regeneration (was failing on main) |
| Client regeneration consistency | packages/client | no diff (client was never stale) |
| Rust | crates/* | NOT RUN — no Rust toolchain in this environment |
