# Role Capability Matrix

Generated from the real role definitions on this branch
(`packages/core/src/mcp/role-profiles.ts` — profiles derived from each
role's tool list; budgets from `defaultMcpLimit` in
`packages/core/src/tool/plugin/orchestra.ts`). Regenerate after role
changes; do not hand-edit rows.

Reading the columns:

- **Required MCP** — servers the role's own rules name; `McpCatalog.Plugin`
  flags them in the role's context when unavailable, and acquisition for the
  role prioritizes them.
- **Allowed MCP** — the role's ceiling: servers its tool list reaches.
  Nothing outside this list can be advertised to the role, assigned to it,
  or acquired on its behalf (`acquire_mcp` refuses, it does not widen).
- **Assigned MCP** — per task, not per role: the Orchestrator narrows the
  ceiling per hand-out through the `sessions` tool `mcp` field (allowlist +
  budgets). At rest nothing is assigned.
- **Task budget** — the default per-task ceiling the Orchestrator may
  distribute from (24 calls, 12 for read-only roles, 0 when a role reaches
  no servers). Distribution is tighten-only and enforced at the dispatch
  boundary (deny rules + the budget gate), never by the worker's promise.
- **Status** — every profile below is produced by the derivation and covered
  by `packages/core/test/mcp-role-profiles.test.ts`.

| Role | Required MCP | Allowed MCP | Assigned MCP | Task budget | Status |
|---|---|---|---|---|---|
| generalist | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, time, windows | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| product-analyst | — | brave-search, context7, deepwiki, fetch, filesystem, git, github, mcp-docs, memory, sequential-thinking | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| architect | — | brave-search, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, rea-anything, sentry, sequential-thinking, time | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| researcher | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, time | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| deep-researcher | context7, deepwiki, git, github, mcp-docs, playwright, rea-anything | brave-search, chrome-devtools, desktop-commander, fetch, filesystem, memory, sentry, sequential-thinking, time, windows | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| strategic-planner | — | brave-search, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, rea-anything, sentry, sequential-thinking, time | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| designer | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, sentry, sequential-thinking, time, windows | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| developer | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, time, windows | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| frontend-developer | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, time, windows | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| backend-developer | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, time | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| mobile-developer | memory | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, playwright, rea-anything, sentry, sequential-thinking, time, windows | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| desktop-developer | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, time, windows | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| database-engineer | — | brave-search, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, sentry, sequential-thinking, time | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| writer | — | brave-search, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, sentry, time | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| devops | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, sentry, sequential-thinking, time | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| debugger | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, time, windows | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| tester | time | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, windows | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| reviewer | git | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, time | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| counterexample-engineer | — | brave-search, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, sentry, sequential-thinking, time | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| security-auditor | rea-anything | brave-search, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, sentry, sequential-thinking, time | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| accessibility-auditor | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, sentry, sequential-thinking, time, windows | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| performance-engineer | memory | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, playwright, sentry, sequential-thinking, time, windows | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| dependency-auditor | — | brave-search, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, rea-anything, sentry, sequential-thinking, time | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| compatibility-engineer | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, time, windows | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| data-migration-engineer | time | brave-search, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, sentry, sequential-thinking | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| reliability-engineer | — | brave-search, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, sentry, sequential-thinking, time | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| core-maintainer | time | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, windows | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| integration-engineer | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, time, windows | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| api-contract-engineer | — | brave-search, chrome-devtools, context7, deepwiki, desktop-commander, fetch, filesystem, git, github, mcp-docs, memory, playwright, rea-anything, sentry, sequential-thinking, time | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| orchestrator | sequential-thinking, memory | all installed servers | — (per task) | uncapped by role; session permissions decide | profile derived + tested |
| president | — | — | — (per task) | — | profile derived + tested |
| build | — | all installed servers | — (per task) | uncapped by role; session permissions decide | profile derived + tested |
| general | — | all installed servers | — (per task) | uncapped by role; session permissions decide | profile derived + tested |
| explore | — | brave-search, context7, deepwiki, fetch, mcp-docs | — (per task) | — | profile derived + tested |
| notes | — | — | — (per task) | — | profile derived + tested |
| compaction | — | — | — (per task) | — | profile derived + tested |
| title | — | — | — (per task) | — | profile derived + tested |
| summary | — | — | — (per task) | — | profile derived + tested |

Notes on the non-team profiles (also generated above):

- **orchestrator** is unrestricted by design — it inspects connected servers
  and allocates them to roles; its own required pair is
  sequential-thinking + memory (planning and durable team facts).
- **president** (group supervisor) and the hidden utility agents
  (**notes**, **compaction**, **title**, **summary**) hold no MCP access.
- **build** / **general** carry no MCP narrowing of their own; the
  configured session permissions decide.
- **explore** is the narrowest working profile: read-only documentation and
  fetch servers only (context7, deepwiki, fetch, mcp-docs, brave-search).
- `android_helper` was removed from every role ceiling in Б9: no such MCP
  server exists anywhere in the code (no catalog entry, no tool ever
  registers `android_helper_*`), so the grant was a ghost — roles named a
  capability they could never reach. If an Android-device server is ever
  added to the catalog, its id goes back into the ceilings through the
  same derivation, not by hand.
- Custom roles saved by the operator derive profiles through the same
  `fromRole` path, so they appear in this matrix's generation unchanged.
