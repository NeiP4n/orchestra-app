# Session Reliability — Forensic Audit V2 (partial)

- The session soft-lock the owner hit had two stacked causes, fixed in two
  steps: queued relocation moves that could never drain (PR #32, pre-audit)
  and the location sync failure model (F-LOC-1, this audit). Sessions
  themselves kept running throughout — the failure was in the client's
  availability gate, not in the runner.
- Session execution drain failures are logged with the session ID
  ("Failed to drain Session"); the runner's inbox contract (steer vs queue
  delivery) was re-verified while fixing the move trap in PR #32.
- MCP budget state per session is durable across restarts via KV
  write-through, keyed by the task epoch (F-MCP-1).
- Not executed in this pass: the adversarial crash matrix (crash after
  admission, duplicated deliveries, deletion during execution). No claims.
