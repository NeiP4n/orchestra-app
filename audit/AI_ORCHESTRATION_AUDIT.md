# AI Orchestration Audit — Forensic Audit V2 (partial)

- F-MCP-1 (fixed): orchestrator MCP limits are now enforced at dispatch, not
  merely stamped and described. The 6-message delegation rule and per-role MCP
  distribution from the earlier program (PR #24) were re-verified as the
  distribution half of this fix; `AiStandard.stepCeilings` consumption by the
  runner (PR #30) remains as previously verified.
- The step ceiling is a step ceiling, not a spending cap — the standard's text
  says so since PR #30; the global `Limits` enforcement default (off unless
  ORCHESTRA_ENFORCE_LIMITS is set) is unchanged and remains a product-policy
  decision for the owner.
- Provider/model catalogs are the prime suspects in the owner's location 500s
  (network/geo-dependent), but the failing service was not isolated without
  his server log; see RESIDUAL_RISKS.md.
- Not inspected in this pass: tool-result ordering, plugin lifecycle cleanup,
  team result aggregation beyond the previously merged work.
