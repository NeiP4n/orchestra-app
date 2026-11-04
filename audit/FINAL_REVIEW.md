# Final Review — Forensic Audit V2

Independent re-read of the branch diff (lead reviewing as a second developer):

- Diff scope: 2 client files + 1 client test (F-LOC-1); 2 core source files +
  1 new core module + 2 core test files (F-MCP-1); audit documents. No server,
  protocol or generated-client changes remain (the middleware experiment was
  fully reverted and the worktree verified clean of it).
- F-LOC-1: `Promise.allSettled` cannot swallow the identity check — `syncInfo`
  is awaited before the fan-out in both layers. Stale catalogs after a failed
  sync behave exactly like event-refresh failures already did. No API change.
- F-MCP-1: the gate sits in the single dispatch funnel (`MCP.callTool`); its
  only production caller passes `sessionID`. Reserve is synchronous; KV
  write-through happens after a successful reserve; epoch handling prevents
  both cross-task leakage and restart resets. Allowlist denials do not consume
  budget; cap denials do not consume either; successful reserves count even if
  the call then fails (deliberate, documented in the module header).
- Tests discriminate: the client regression test and 2 of 3 dispatch tests
  fail on the unfixed code; all pass on the branch. Typecheck deltas are zero
  (core 11 = baseline; client clean); decoupling check passes.
- No secrets, no unrelated files, no generated artifacts in the diff.
- Remaining concerns are recorded in RESIDUAL_RISKS.md rather than smoothed
  over; the largest is the still-unidentified server-side cause of the
  owner's 500s, which needs his server log.
