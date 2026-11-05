# Role Capability Matrix

Generated from the real role definitions on this branch
(`packages/core/src/mcp/role-profiles.ts` — profiles derived from each
role's tool list; budgets from `defaultMcpLimit` in
`packages/core/src/tool/plugin/orchestra.ts`). Regenerate after role
changes with `bun run script/generate-role-capability-matrix.ts` from
`packages/core`; do not hand-edit rows.

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
| generalist | — | agent-desktop, context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| product-analyst | — | context7, deepwiki, github, serena | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| architect | — | context7, deepwiki, github, rea-anything, serena | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| researcher | — | context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| deep-researcher | context7, deepwiki, github, playwright, rea-anything | agent-desktop, context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| strategic-planner | — | context7, deepwiki, github, rea-anything, serena | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| designer | — | agent-desktop, context7, deepwiki, github, playwright, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| game-designer | — | context7, deepwiki, github, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| marketer | — | agent-desktop, context7, deepwiki, github, playwright, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| developer | — | agent-desktop, context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| frontend-developer | — | agent-desktop, context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| backend-developer | — | context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| mobile-developer | — | agent-desktop, context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| desktop-developer | — | agent-desktop, context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| database-engineer | — | context7, deepwiki, github, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| writer | — | context7, deepwiki, github, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| devops | — | context7, deepwiki, github, playwright, sentry, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| system-administrator | — | context7, deepwiki, github, sentry, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| support-engineer | — | agent-desktop, context7, deepwiki, playwright, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| debugger | — | agent-desktop, context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| tester | — | agent-desktop, context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| reviewer | — | context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| counterexample-engineer | — | context7, deepwiki, github, serena | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| security-auditor | rea-anything | context7, deepwiki, github, rea-anything, serena | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| accessibility-auditor | — | agent-desktop, context7, deepwiki, github, playwright, serena | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| performance-engineer | — | agent-desktop, context7, deepwiki, github, playwright, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| dependency-auditor | — | context7, deepwiki, github, rea-anything, serena | — (per task) | ≤12 calls/task (tighten-only) | profile derived + tested |
| compatibility-engineer | — | agent-desktop, context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| data-migration-engineer | — | context7, deepwiki, github, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| reliability-engineer | — | context7, deepwiki, github, sentry, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| core-maintainer | — | agent-desktop, context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| integration-engineer | — | agent-desktop, context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| api-contract-engineer | — | context7, deepwiki, github, playwright, rea-anything, serena | — (per task) | ≤24 calls/task (tighten-only) | profile derived + tested |
| orchestrator | — | all installed servers | — (per task) | uncapped by role; session permissions decide | profile derived + tested |
| president | — | — | — (per task) | — | profile derived + tested |
| build | — | all installed servers | — (per task) | uncapped by role; session permissions decide | profile derived + tested |
| general | — | all installed servers | — (per task) | uncapped by role; session permissions decide | profile derived + tested |
| explore | — | context7, deepwiki | — (per task) | — | profile derived + tested |
| notes | — | — | — (per task) | — | profile derived + tested |
| compaction | — | — | — (per task) | — | profile derived + tested |
| title | — | — | — (per task) | — | profile derived + tested |
| summary | — | — | — (per task) | — | profile derived + tested |

Notes on the non-team profiles (also generated above):

- **orchestrator**: Unrestricted: it inspects the connected servers and allocates them to roles; its planning and durable team facts live in the native board and notes, so no MCP server is required.
- **president**: Group supervisor ruleset denies tools; a group chat coordinates, it does not call MCP servers.
- **build**: The default agent carries no MCP narrowing of its own; configured permissions decide.
- **general**: General-purpose subagent with no MCP narrowing of its own; configured permissions decide.
- **explore**: Read-only codebase explorer: deny-all except native search/read and web access, whose implied MCP documentation and fetch servers are the ones listed.
- **notes**: The note chat is deny-all except the note tool, reading and questions.
- **compaction**: Hidden utility agent; no tool access is granted for MCP work.
- **title**: Hidden utility agent under a deny-all ruleset.
- **summary**: Hidden utility agent under a deny-all ruleset.

- `android_helper` was removed from every role ceiling in Б9: no such MCP
  server exists anywhere in the code (no catalog entry, no tool ever
  registers `android_helper_*`), so the grant was a ghost — roles named a
  capability they could never reach. The `android` tool group in the team
  editor was removed with it; Android devices are reached through the
  Registry (adb programs), not through MCP. If an Android-device server is
  ever added to the catalog, its id goes back into the ceilings through the
  same derivation, not by hand.
- Custom roles saved by the operator derive profiles through the same
  `fromRole` path, so they appear in this matrix's generation unchanged.
