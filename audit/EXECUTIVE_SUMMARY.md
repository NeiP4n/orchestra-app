# Executive Summary — Forensic Audit V2

Branch `forensic-audit`, based on verified remote default branch `main` @ 2e8fd85.

## What was done
- Baseline established (git state, package/crate inventory, known typecheck and
  test baselines) before any change; see WORKLOG.md and TEST_RESULTS.md.
- Two confirmed defects fixed with regression tests:
  - F-LOC-1 (P2): a single failing location catalog endpoint declared the whole
    location "unavailable" and soft-locked sessions on the owner's machine.
    The client catalog fan-out is now best-effort; only the location identity
    check can mark a location unavailable.
  - F-MCP-1 (P1): the Orchestrator's per-task MCP budgets (total cap, per-server
    caps, allowlist) are now enforced at the single dispatch point,
    `MCP.callTool`, with atomic reservation, per-task epochs and restart-safe
    usage persistence.
- One pre-audit confirmed fix inventoried (F-ROOM-1, PR #31).
- Two further confirmed issues documented but deliberately not fixed in this
  branch: stale committed `openapi.json` (F-GEN-1, P3) and the default-branch
  documentation discrepancy (F-DOC-1, P4).

## What was not done
- The six investigation tracks ran sequentially by the lead engineer, not as
  six parallel agents, per the owner's standing order (see WORKLOG.md).
  Coverage is deep on confirmed paths and partial elsewhere; COVERAGE_MATRIX.md
  marks every area honestly, including NOT INSPECTED ones (PTY/transport, Rust
  crates, app/desktop surfaces, plugins, performance).
- The server-side root cause of the owner's 500s (which catalog dies on his
  machine and why) is still unidentified; the fix removes the lockout for
  catalog failures. His server log from a failure moment remains the key
  evidence — see RESIDUAL_RISKS.md.

## Verification
- Core typecheck: 11 errors = clean-main baseline. Client typecheck: clean.
  check:decoupling: PASS.
- New/changed tests all pass and were verified to fail on the unfixed code
  where applicable (client location sync; MCP dispatch caps).
- Server typecheck was used as a guardrail: an over-broad middleware change
  was caught by it (117 vs 11) and reverted before commit.
