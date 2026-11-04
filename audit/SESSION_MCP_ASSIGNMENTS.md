# Session MCP Assignments — what each session was actually granted

Date: 2026-11-04. Base: `main` @ `9ffabbd`.

## The problem

The sidebar listed the location-wide MCP inventory: which servers exist and
are connected globally. It could not answer "which MCPs did the Orchestrator
grant to THIS session for its actual task?" Worse, the assignment state was
ambiguous: the sessions tool stamped an MCP limit on a session **only when
the Orchestrator passed an explicit `mcp` field** ("No `mcp` field, no
stamp"), so a missing stamp could mean anything.

## Five concepts, kept separate

1. **Required by stage** — a stage's `mcp` field. A plan, never a grant;
   never displayed as an assignment.
2. **Allowed by role** — the role's MCP ceiling (`mcpServersOf` over its
   tool patterns). A maximum, not a grant.
3. **Assigned to session** — the Orchestrator's per-task grant at dispatch.
   This is what the sidebar shows.
4. **Connected globally** — the location's live server status. Used only to
   say whether an assigned server is currently usable.
5. **Usable by session** — assigned AND connected (and thereby
   tool-discoverable through the runtime); the sidebar's per-row state.

## The assignment record (core)

`packages/core/src/tool/plugin/orchestra.ts`:

- New metadata key `orchestra:mcp-assignment` (`MCP_ASSIGNMENT_METADATA_KEY`)
  and a pure reader `mcpAssignmentOf(metadata)` (tested in
  `packages/core/test/mcp-assignment.test.ts`).
- `distributeMcp` now stamps the record on **every** `send`/`create`
  dispatch to a session that has a team role:
  - With an explicit `mcp` field: the record mirrors the enforced limit
    (allowlist, maxCalls, perServer), `explicit: true`, and the **same
    budgetEpoch** as the limit stamp — the displayed grant is tied to the
    exact budget the gate enforces. Enforcement is unchanged: deny rules
    for servers outside the allowlist + the budget gate on the limit stamp.
  - Without an `mcp` field: the record is the role's ceiling,
    `explicit: false`, `budgetEpoch: null`. Enforcement is unchanged
    (no limit stamp, no deny rules — exactly as before). The record only
    makes the inherited state visible and labelled as inherited.
  - An explicit empty allowlist stamps `servers: []` — an assignment of
    **no MCP**, displayed as "No MCP assigned", never confused with a
    missing record.
  - No record at all now unambiguously means "no task has been dispatched
    to this session yet" — displayed as "Not assigned yet".
- A session without a team role gets no record (there is no ceiling to
  distribute from), and passing `mcp` for one still fails, as before.
- Reusing a worker for a new task re-dispatches and **replaces** the record
  (and the budget epoch) — assignments never merge across tasks.
- Restart recovery is free: the record lives in the session's persisted
  metadata, so it survives application restarts with the session.

## Security boundaries (unchanged, and now visible)

The record is display truth, not a permission source. Role ceilings are
never widened (`resolveMcpLimit` still refuses out-of-ceiling servers and
caps), budgets still gate every call, deny rules still close non-allowlisted
servers, and lifecycle leases/pins are untouched. The sidebar renders the
record read-only; clicking a row opens the MCP manager and grants nothing.

## Lifecycle port (base for this work)

`main` did not yet contain the MCP lifecycle mission's code (it lived only
on the `mcp-lifecycle-autonomy-ui` branch). It was ported onto `main` as
part of this delivery, unchanged in behaviour: `packages/core/src/mcp/lifecycle.ts`
(default-off migration, leases, operator pins, ownership), the `mcp_manager`
tool (main sessions only, ceiling-guarded), the migration wiring in
`config/plugin/mcp.ts`, and its tests (`mcp-lifecycle.test.ts`). The theme
state-contrast repair from that branch was already in `main` via the review
round and was not duplicated; its sidebar compaction is superseded by
`TEAM_MCP_SIDEBAR.md`'s design.

## Limitations

- Per-task **usage counters** (calls spent per epoch) live in the core
  budget gate's KV rows and are not exposed through the client API, so the
  sidebar shows the assignment and its caps but not live spend. Nothing is
  estimated or invented to fill that gap.
- The record reflects the session's **latest** dispatch. A completed task's
  assignment remains visible as the session's current record until the next
  dispatch replaces it; it is never presented as a live grant for a new
  task, and enforcement for a new task always comes from that task's own
  dispatch.
