# Audit V3 — Addendum

Continuation of the forensic audit on branch `audit-v3` (based on
`forensic-audit` @ 8598160, itself on main @ 2e8fd85; main verified unchanged).

## Phase 1 — MCP budget hardening (F-MCP-1 revisited)

The V2 gate (in-memory counters + KV snapshot write-through) did NOT meet
the invariant "never more calls than budget, regardless of concurrency,
restarts, or number of instances/processes". Confirmed weaknesses:

1. Two reservers could act on the same KV snapshot (the gate re-read the
   row per call, but check-and-write were separate steps outside any
   transaction; two processes sharing the database could both pass).
2. A crash between the in-memory reservation and the KV write lost the
   reservation entirely.
3. A corrupted persisted-usage row was silently treated as zero —
   fail-open: spent budget handed back.

Redesign (no second source of truth — the same KV row, the same format):
a reservation is now ONE immediate database transaction
(`db.transaction(..., { behavior: "immediate" })`, the pattern bus.ts and
credential.ts already use): read the usage row, `decide` (pure:
allowlist → total → per-server), write the incremented row, commit —
dispatch happens only after commit. SQLite serializes immediate
transactions across every connection to the file (WAL, busy_timeout
5000), so the cap holds across fibers, MCP instances and server
processes. Reservation and persistence are the same event, so scenarios
2 and 3 above change as follows: a store failure refuses the call
(fail-closed, logged), and a corrupted row refuses the session's calls
until cleanup removes it — it is never silently zeroed.

Scenario verdicts (the 15 from the task):
1. Concurrent final slot — SAFE now; tested with parallel fibers on one
   connection and with two connections to one file: exactly one commits.
2. Same-snapshot double reserve — eliminated by construction (no snapshot).
3. Write failure after reservation — impossible state; failure precedes
   dispatch and refuses the call.
4. Crash between reserve and persist — impossible; they are one commit.
5. Multiple processes, one database — covered by SQLite transaction
   serialization (two-connection test is the in-process proxy).
6. Multiple MCP instances — same row, same mechanism.
7/8. Task/epoch replacement mid-flight — sound: calls reserved under the
   old epoch were within its budget and complete; new calls gate on the
   new epoch; the first new-epoch reservation atomically replaces the row.
   Tested at the reserve level.
9. Session deletion/recreation — recreation with a new stamp starts
   clean; stale rows are removed by the cleanup below.
10. Metadata racing dispatch — each call reads its stamp fresh, then
    reserves against that stamp's epoch atomically; a racing update
    applies to the next call. No torn state.
11. Corrupted usage — fail-closed now (was fail-open). Tested.
12. Stale usage — bounded cleanup: stamp removal deletes the row at the
    next consult; a startup sweep deletes rows whose session is gone,
    unstamped, or epoch-mismatched. Active-task rows (epoch matches the
    live stamp) are never touched.
13. Calls without sessionID — ungated by design: there is no task to
    charge (ordinary user sessions carry no budget). Unchanged.
14. Alternate execution paths — verified: `tool/mcp.ts` is the only
    production caller of `MCP.callTool`; Code Mode executes through the
    same registered tool path and forwards the sessionID.
15. Permission-denied calls — verified in `tool/mcp.ts`:
    `permission.assert` runs before `callTool`, so denied calls never
    reach the gate and never consume budget.

Tests: packages/core/test/mcp-budget.test.ts rewritten (16 tests: parse,
decide, reserve on in-memory DB, two-connection file DB race + resume,
corruption, epoch replacement, cleanup primitives). The dispatch
integration block in test/mcp.test.ts still passes (3/3). Core typecheck
back to the 11-error baseline after the rewrite.

## Phase 2 — Location failure diagnostics

The shared HttpApi error union was NOT widened (V2's lesson). Instead:
- packages/server/src/location.ts: the location middleware now logs any
  defect (die reason) with its full cause and the directory, via
  `Effect.onError`. Typed errors stay unlogged; nothing the client sees
  changes. The next 500 on the owner's machine will name the dying
  service and stack in the server log.
- packages/client/src/solid/data.ts: the best-effort catalog fan-out now
  logs each rejected catalog BY NAME instead of discarding settled
  results silently. packages/tui/src/context/data.tsx logs config sync
  failures the same way.
The actual failing service on the owner's machine is still unidentified
— no log from his machine exists yet; no claim is made about it.

## Phase 3 — Previously uninspected areas (scoped passes)

- PTY / persistent PTY (INSPECTED): outbound frames flow through
  `PtyOutbox` (packages/server/src/pty-outbox.ts), bounded at 16 MiB /
  8192 frames; overflow latches, closes the socket with code 1013 and
  the client resyncs from its cursor — no silent loss, no unbounded
  growth. Replay and live output share one ordered writer; replay
  truncation is surfaced to the client. No defect confirmed.
- Rust (INSPECTED, NOT COMPILED): no Rust toolchain exists in this
  environment, so nothing was built or tested — stated plainly. The
  three library crates are small (kernel 311, memory 281, session 208
  lines). The kernel transport pool fails over only before any output
  is emitted (no spliced/duplicated answers), with per-transport
  resting backoff; fatal/context-overflow errors never fail over.
  Remaining `lock().unwrap()` sites would panic only on mutex
  poisoning. The `orchestra` crate is a standalone CLI binary.
- Plugins (PARTIAL): hook registration is centralized
  (plugin/host.ts → hooks.register for permission/shell/tool/session);
  the full lifecycle/cleanup audit of the 699-line host and instance
  machinery was not completed in this pass.
- App surfaces / performance (PARTIAL): no new surface testing; the
  budget sweep is bounded by the number of usage rows (paged scan) and
  forked off the startup path. No measurements taken; no claims made.

## Phase 4 — Contract and documentation

- F-GEN-1 CLOSED: the +1301/−95 regeneration delta was analyzed hunk by
  hunk. It is entirely legitimate staleness: 8 operations that already
  exist in the protocol groups (orchestra.rules.*, orchestra.group.*,
  orchestra.society.create, quota.check), newer Config/Mcp/Quota
  schemas, x-opencode-ticket header parameters, and error declarations
  endpoints already carry. Zero operations removed. Regenerated in a
  dedicated commit (4fb6d3e); `check:generated` passes; the generated
  client regenerates with no further diff (it was never stale — it
  builds from the live API).
- F-DOC-1 CLOSED: AGENTS.md claimed a `v2` default branch that does not
  exist; corrected to the verified `main` with the verification method
  noted inline.

## Phase 5 — Verification

See TEST_RESULTS.md (V3 section). Skeptical review: the budget redesign
was re-read as an adversary — the remaining theoretical hole is a
busy-timeout exhaustion under extreme cross-process contention, which
fails closed (refusal), never open. The startup sweep can delete a
corrupted row whose session still carries a stamp; that is the intended
recovery path for corruption, and it is bounded to service start.
