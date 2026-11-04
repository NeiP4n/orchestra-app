# Final Verification — mcp-role-orchestration

Branch commits: `edd95c8` (theme readability floor), `ffa2f99` (dynamic
stages), `5335718` (MCP acquisition + sessions-tool wiring), plus the
test-stub and documentation commits on top. Base: `origin/main` 569d095.
Not merged, per mission §17.

## Typecheck (canonical gate, vs clean-main baselines)

| Package | Result |
|---|---|
| core | **11 errors = baseline** (dream-team 3, muse-chat 7, tool/plugin/orchestra.ts 1 — all pre-existing). One new error found and fixed during verification: the test stub `test/lib/orchestra.ts` lacked the new Interface methods |
| tui | 11 = baseline (verified with the theme fix) |
| theme | tests 5/5 (fixture revived from the PR #36 removal) |

## Tests executed

New tests (all pass):

| Suite | Result |
|---|---|
| `core/test/orchestra-stage.test.ts` (pure stage model) | 10/10 |
| `core/test/mcp-acquire.test.ts` (classify/select/ensure vs the real Access slice) | 10/10 |
| `core/test/orchestra-team.test.ts` → "Orchestra workflow stages" (real layer: plan, gated start, evidence-gated completion, KV persistence, replan, typed errors) | pass |
| `tui/test/theme-contrast.test.ts` (every theme × mode × rendered token pairs) | pass — 0 pairs below 3.0:1 after the fix (276 before) |

Regression suites (all pass): orchestra-team, orchestra-tool-mode,
orchestrator-limits, plugin/orchestra, mcp-catalog, mcp-role-profiles,
mcp-budget, mcp (85/85), mcp-forge, mcp-instructions, mcp-import-boundary,
mcp-useful-registry, mcp-oauth, orchestra-permission, orchestra-role-quality
(40), orchestra-worker-model (26), orchestra-factory-verification,
dream-team, dod (22), theme suites (23/23).

Pre-existing failures, **verified identical on clean main** by direct
comparison runs in the same sandbox:

| Suite | Clean main | This branch |
|---|---|---|
| `mcp-reaper.test.ts` | 1 pass / 1 fail (process-tree kill, sandbox-dependent) | 1 pass / 1 fail |
| `orchestra-worker-policy-e2e.test.ts` | 0/6 ("registerToolPlugin does not support tool hooks") | 0/6, same cause |

Known pre-existing failure families not re-run (untouched areas, recorded
baselines): session-runner (36), plugin/optimize (4), TUI V2-resolver drift.

## Mission scenarios (§14) — coverage

| Scenario | Verdict |
|---|---|
| A. Automatic MCP acquisition | Covered at the acquisition layer: select → validate → install → connect → verify-by-discovered-tools, reuse of healthy servers, honest failure states (unit tests vs the real service interface; the service's connection machinery itself is covered by `mcp.test.ts` 85/85). **Not** executed as a live download-and-run of an external package in the sandbox — see limitations |
| B. Role isolation | Pre-existing enforcement re-verified (profiles, per-task deny rules, budget gate suites pass); `acquire_mcp` refuses out-of-ceiling servers for a named role |
| C. MCP failure | Failed servers classify `failed` with the service's error, are not retried silently; connected-without-tools is `degraded`, and unavailable tools are never advertised (plugin context lists only connected/pending + role-reachable) |
| D. Missing credentials | `needs_auth` before any install; variables named, values never invented or logged (unit tests) |
| E. Dynamic workflow | Integration test: a stage added by replanning while a completed stage's evidence survives untouched |
| F. Parallel stages | Dependency math (`actionable`) unit-tested; concurrent execution is the existing per-session dispatcher (orchestra-team suite) |
| G. Invisible text | Registry-wide contrast test through the real resolver, all themes and modes |
| H. Long-running task | Stages persist in the project KV (integration test re-reads through the store after writes); pending-task recovery is pre-existing and covered by the team suite |

## Security checks

- Diff scanned: no credentials, tokens or generated artifacts; no unrelated
  modifications (`git diff --check` clean).
- No widening path added: role ceilings (`mcpServersOf`,
  `resolveMcpLimit`) are read, never mutated; acquisition installs globally
  but grants no role access; per-role removal remains an allowlist/profile
  operation and never disconnects the shared server.
- Disabled MCP servers are never re-enabled by acquisition; failed servers
  are not auto-retried.
- Stage transitions are enforced in the service's pure model, not by
  prompt: dependency gating, evidence-required completion, completed-stage
  immutability all hold against direct service calls (integration test).

## Performance observations

- The capability-awareness contract remains a fixed ~627-token suffix
  (size-guarded by test); the stage context block renders only when a plan
  exists and sits outside the cacheable roster block.
- Contrast repair runs once per theme resolution; themes already meeting
  the floors resolve byte-identical.
- Stage storage is one KV record per project; plan/stage operations are
  O(plan size).

## Remaining limitations (stated, not hidden)

1. **No live external MCP install was executed** in this sandbox (it would
   download and run third-party packages). `ensure()` is verified against
   the service interface and the service's own suite; a first live run
   should be observed once on the operator's machine.
2. **Stages have no HTTP/TUI surface yet**: they are exposed through the
   Orchestrator's `sessions` tool and its context, the same surfaces that
   carry playbook/outcomes today. No Protocol change was made, so no client
   regeneration was needed; a panel view is a follow-up, not a gap in the
   runtime behavior.
3. Transparent-background themes cannot be contrast-repaired (the real
   surface is the user's terminal); documented in UI_TEXT_VISIBILITY.md.
4. Parallel-stage file ownership is the Orchestrator's planning duty (the
   plan records session assignment per stage); the runtime enforces
   dependencies and single-assignment of tasks, not file locks.
5. Execution note: the mission suggested up to six parallel subagents; the
   work was executed solo and sequentially under the operator's standing
   order (a prior parallel swarm overloaded the platform), with each
   increment verified before the next.
