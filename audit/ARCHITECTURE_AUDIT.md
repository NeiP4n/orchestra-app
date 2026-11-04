# Architecture Audit — Forensic Audit V2 (partial)

- Dependency direction holds where checked: `bun run check:decoupling` passes
  (6385 files); `packages/client/src` has no imports of `@orchestra/core` or
  `@orchestra/server` outside generated code (grep-verified).
- The MCP budget fix respects the existing layering: enforcement lives in core
  at the single dispatch funnel; distribution stays in the Orchestra plugin;
  the shared contract is the stamped session metadata + KV usage records.
- The location data layer's failure model was inconsistent before F-LOC-1:
  event-driven refreshes tolerated endpoint failures while the location sync
  path treated the same failures as fatal. The fix aligns them.
- Generated artifacts: `packages/protocol/openapi.json` is stale on main
  (F-GEN-1) — the protocol's generated snapshot no longer matches its sources,
  while the generated promise client does regenerate deterministically from
  the live API definition (verified during the reverted experiment).
- Documentation: AGENTS.md still names `v2` as the default branch; the remote
  HEAD is `main` (F-DOC-1).
- Developer-workflow note (observed, not a product defect): in a git worktree
  whose `node_modules` are symlinked from another checkout, Bun resolves
  cross-package `@orchestra/*` imports through relative symlinks into the
  OTHER checkout's sources, so code generation and typechecking can silently
  use the wrong tree. This audit's worktree was rebuilt with per-package
  link forests pointing at its own sources before trusting any result.
