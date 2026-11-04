# Coverage Matrix — Forensic Audit V2

| Area | Status | Notes |
| --- | --- | --- |
| Repository / git baseline | COMPLETE | Remote HEAD verified = main (2e8fd85); inventory: 38 packages, 4 Rust crates |
| Architecture / dependency rules | PARTIAL | check:decoupling PASS; client→core/server import grep clean; full graph audit not exhaustive |
| Core: MCP dispatch + budgets | COMPLETE | F-MCP-1 fixed; unit + real-dispatch integration tests |
| Core: rooms / KV | COMPLETE | F-ROOM-1 (pre-audit fix, re-verified in code) |
| Core: session lifecycle / runner | PARTIAL | Move path + drain logging inspected; adversarial crash-matrix not executed |
| Core: storage / SQLite | PARTIAL | In-memory test DB behaviour verified via budget integration tests |
| Server: location middleware / handlers | PARTIAL | F-LOC-1 path traced end to end; typed-503 attempt reverted (see findings) |
| Server: LAN rooms | PARTIAL | Join/password/ban gates read and verified; no live multi-device test |
| Server: PTY / transport | NOT INSPECTED | No confirmed reports; out of the time-boxed scope |
| Protocol / generated client | PARTIAL | F-GEN-1 confirmed (stale openapi.json); client regeneration mechanics verified |
| Security | PARTIAL | Targeted read of room join + auth error surface; no full threat-model sweep |
| AI runtime / orchestration | PARTIAL | MCP budgets + orchestrator limits verified; provider catalog behaviour is the F-LOC-1 suspect, not isolated |
| Plugins | NOT INSPECTED | Beyond the earlier proxy/WARP removals |
| Client data layer (solid) | COMPLETE | F-LOC-1 fixed + regression test |
| TUI session screen / location UI | PARTIAL | Blocking mechanism traced and fixed at the data layer; TUI not run (owner prohibition on standalone runs) |
| App / desktop / web | NOT INSPECTED | The shared client fix benefits them; no surface testing |
| Rust crates | NOT INSPECTED | Toolchain verification not run in this pass |
| CI / release | PARTIAL | check.yml + root check composition read; pipelines not executed |
| Performance / long-run | NOT INSPECTED | No measurements taken; no claims made |

## V3 updates
| Area | Status | Notes |
| --- | --- | --- |
| Core: MCP budgets | COMPLETE | Transactional reservation; concurrency + corruption + cleanup tested (AUDIT_V3 Phase 1) |
| Server: PTY / persistent PTY | PARTIAL→INSPECTED | PtyOutbox bounded (16 MiB / 8192 frames), overflow closes 1013 + cursor resync; no defect confirmed |
| Rust crates | INSPECTED (read-only) | No toolchain in this environment — not compiled or tested; kernel failover logic verified by reading |
| Plugins | PARTIAL | Centralized hook registration verified; full lifecycle audit not completed |
| Protocol / OpenAPI | COMPLETE | F-GEN-1 closed; check:generated passes; client generation consistent |
| Performance | PARTIAL | Budget sweep bounded + forked; no measurements taken |
