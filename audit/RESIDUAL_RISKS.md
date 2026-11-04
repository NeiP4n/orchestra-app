# Residual Risks — Forensic Audit V2

1. **The owner's 500 root cause is still unidentified.** F-LOC-1 removes the
   lockout when a *catalog* endpoint fails. If on his machine `location.get`
   itself (the identity check) is what dies, a location will still be reported
   unavailable — now correctly, but still unexplained. Needed evidence: the
   server-side log line at the moment of a 500, which names the dying service.
   Prime suspects remain the network/geo-dependent catalogs (provider/model
   data; the owner is geo-restricted for some models).
2. **Location defects are still bare 500s.** The typed-503 translation at the
   location middleware was implemented and reverted: adding
   `ServiceUnavailableError` to the middleware's declared errors changed every
   location endpoint's error union and broke handler type inference across the
   server package (117 typecheck errors vs the 11-error baseline), with
   cascading errors in ~30 files. A future fix should either adjust the shared
   `response()`/handler typing so handlers can declare the wider union, or
   translate defects below the HttpApi layer. Until then the failing service
   is only identifiable from server logs.
3. **F-GEN-1:** the committed `packages/protocol/openapi.json` lags the
   protocol (+1301/−95 on clean regeneration). Any consumer of that file sees
   a stale API. Regenerate in a dedicated commit.
4. **MCP budget crash gap (documented in code):** a crash between a budget
   reservation and its KV write-through can lose the in-flight calls' counts;
   bounded at the calls in flight at the crash. Reservations are never
   refunded, including for calls that fail at the server — that is deliberate
   (retry loops cannot launder budget), and worth the owner's awareness.
5. **Undecided subsystems:** zen-models auto-probing, freebuff,
   plugin-antigravity-auth and the jailbreak prompt library remain in the tree
   awaiting the owner's decision (flagged in his earlier audit).
6. **Unverified areas:** PTY/transport, Rust crates, app/desktop surfaces,
   plugins and performance were not inspected in this pass (see
   COVERAGE_MATRIX.md); no claims are made about them.

## V3 updates
- F-GEN-1 and F-DOC-1 are closed (see AUDIT_V3 Phase 4); the staleness
  risk remains process-level: nothing in CI was changed by this audit,
  so the snapshot can drift again unless check:generated is enforced.
- MCP budget: under extreme cross-process contention a reservation can
  hit SQLite's busy timeout; that path fails closed (the call is
  refused and logged), never open. The startup sweep deletes corrupted
  usage rows for still-stamped sessions at service start — the intended
  recovery path, bounded to startup.
- The owner's location 500: diagnostics are now in place on both sides
  (server defect log with cause; client catalog names), but the failing
  service is still unidentified until a log from his machine is seen.
