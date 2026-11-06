#!/usr/bin/env bun
/**
 * Regenerates audit/ROLE_CAPABILITY_MATRIX.md from the real role definitions:
 * profiles derived in src/mcp/role-profiles.ts (from each role's tool list)
 * and budgets from defaultMcpLimit in src/tool/plugin/orchestra.ts.
 *
 * Run after any role, tool-group or catalog change:
 *   bun run script/generate-role-capability-matrix.ts
 * The matrix is a report, not a source of truth — never hand-edit its rows.
 */
import { Orchestra } from "@orchestra/schema/orchestra"
import { McpRoleProfiles } from "../src/mcp/role-profiles"
import { OrchestraTool } from "../src/tool/plugin/orchestra"

const dash = "—"
const join = (values: readonly string[]) => (values.length === 0 ? dash : values.join(", "))
const requiredOf = (profile: McpRoleProfiles.Profile) =>
  join(profile.servers.filter((grant) => grant.access === "required").map((grant) => grant.server))
const allowedOf = (profile: McpRoleProfiles.Profile) =>
  profile.unrestricted ? "all installed servers" : join(profile.servers.map((grant) => grant.server))

const budgetOf = (profile: McpRoleProfiles.Profile) => {
  if (profile.kind !== "team-role") {
    if (profile.unrestricted) return "uncapped by role; session permissions decide"
    return dash
  }
  const role = Orchestra.roles.find((item) => item.id === profile.id)!
  const limit = OrchestraTool.defaultMcpLimit(role)
  if (limit.maxCalls === 0) return "0 calls (reaches no servers)"
  return `≤${limit.maxCalls} calls/task (tighten-only)`
}

const teamRows = McpRoleProfiles.all
  .filter((profile) => profile.kind === "team-role")
  .map(
    (profile) =>
      `| ${profile.id} | ${requiredOf(profile)} | ${allowedOf(profile)} | ${dash} (per task) | ${budgetOf(profile)} | profile derived + tested |`,
  )
const standaloneRows = McpRoleProfiles.all
  .filter((profile) => profile.kind !== "team-role")
  .map(
    (profile) =>
      `| ${profile.id} | ${requiredOf(profile)} | ${allowedOf(profile)} | ${dash} (per task) | ${budgetOf(profile)} | profile derived + tested |`,
  )

const standaloneNotes = McpRoleProfiles.all
  .filter((profile) => profile.kind !== "team-role")
  .map((profile) => `- **${profile.id}**: ${profile.note}`)
  .join("\n")

const text = `# Role Capability Matrix

Generated from the real role definitions on this branch
(\`packages/core/src/mcp/role-profiles.ts\` — profiles derived from each
role's tool list; budgets from \`defaultMcpLimit\` in
\`packages/core/src/tool/plugin/orchestra.ts\`). Regenerate after role
changes with \`bun run script/generate-role-capability-matrix.ts\` from
\`packages/core\`; do not hand-edit rows.

Reading the columns:

- **Required MCP** — servers the role's own rules name; \`McpCatalog.Plugin\`
  flags them in the role's context when unavailable, and acquisition for the
  role prioritizes them.
- **Allowed MCP** — the role's ceiling: servers its tool list reaches.
  Nothing outside this list can be advertised to the role, assigned to it,
  or acquired on its behalf (\`acquire_mcp\` refuses, it does not widen).
- **Assigned MCP** — per task, not per role: the Orchestrator narrows the
  ceiling per hand-out through the \`sessions\` tool \`mcp\` field (allowlist +
  budgets). At rest nothing is assigned.
- **Task budget** — the default per-task ceiling the Orchestrator may
  distribute from (24 calls, 12 for read-only roles, 0 when a role reaches
  no servers). Distribution is tighten-only and enforced at the dispatch
  boundary (deny rules + the budget gate), never by the worker's promise.
- **Status** — every profile below is produced by the derivation and covered
  by \`packages/core/test/mcp-role-profiles.test.ts\`.

| Role | Required MCP | Allowed MCP | Assigned MCP | Task budget | Status |
|---|---|---|---|---|---|
${teamRows.join("\n")}
${standaloneRows.join("\n")}

Notes on the non-team profiles (also generated above):

${standaloneNotes}

- \`android_helper\` was removed from every role ceiling in Б9: no such MCP
  server exists anywhere in the code (no catalog entry, no tool ever
  registers \`android_helper_*\`), so the grant was a ghost — roles named a
  capability they could never reach. The \`android\` tool group in the team
  editor was removed with it; Android devices are reached through the
  Registry (adb programs), not through MCP. If an Android-device server is
  ever added to the catalog, its id goes back into the ceilings through the
  same derivation, not by hand.
- Custom roles saved by the operator derive profiles through the same
  \`fromRole\` path, so they appear in this matrix's generation unchanged.
`

const target = new URL("../../../audit/ROLE_CAPABILITY_MATRIX.md", import.meta.url)
await Bun.write(target, text)
console.log(`Wrote ${teamRows.length + standaloneRows.length} profiles to ${Bun.fileURLToPath(target)}`)
