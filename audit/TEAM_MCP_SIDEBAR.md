# Team MCP Sidebar — per-session and per-team assignment visibility

Date: 2026-11-04. Base: `main` @ `9ffabbd`.

## Where it lives

- Pure model: `packages/tui/src/feature-plugins/sidebar/mcp-model.ts`
  (assignment parsing, per-session view, team view, summaries) — unit-tested
  in `packages/tui/test/sidebar-mcp-model.test.ts`.
- Component: `packages/tui/src/feature-plugins/sidebar/mcp.tsx`
  (the existing `orchestra.sidebar.mcp` slot in `sidebar.content`).

## This session

Header: `MCP · THIS SESSION` with a one-line summary:

- `Not assigned yet` — the session has no assignment record (no task was
  ever dispatched to it). Global servers are never shown as assigned here.
- `No MCP assigned` — the record is an explicit empty grant.
- `2 assigned · 2 usable` / `2 assigned · 1 unavailable` — counts from the
  record joined with live connection state.
- `All permitted · N usable` — the role sets no boundary (`servers: "all"`).

An inherited assignment (no explicit `mcp` field at dispatch) is labelled
`Role default — not explicitly assigned`, so an Orchestrator-chosen grant is
never confused with a ceiling inheritance.

Each assigned row shows the server name and its **actual** state:
Connected / Connecting / Error / Disabled / Needs sign-in / Not connected
(assigned but absent from the location's list). Status dots and labels use
semantic theme tokens (`text.feedback.*` for outcome states, `text.muted`
for neutral), never raw colors. Clicking a row opens the MCP manager for
that server — display only, it grants nothing.

## Team assignments

When the viewed session is the project's main Orchestrator session
(agent `orchestrator`), a collapsed-by-default section appears:

```text
▶ Team MCP assignments          3 workers
```

Expanded, each worker gets its own line and its own server list —
assignments are never merged into one global list:

```text
Researcher · 2 MCP
  context7
  deepwiki
Tester · 1 MCP
  playwright · (state shown when not usable)
Writer · 0 MCP
  None
```

Workers come from **that project's own session list**
(`orchestra.project.sessions`), keyed by the viewed session's owner
project (`Orchestra.sessionOwner`) — sessions from other projects are
never fetched, so nothing leaks across project boundaries. A worker's own
sidebar shows only its own assignment (the team section requires the
Orchestrator agent).

## Live updates

- This-session state is reactive: the assignment record and the global
  server list both live in the client data store, which syncs on session
  and `mcp.status.changed` events — dispatch, reconnect, failure and
  auth changes re-render without a restart.
- The team section refetches the project's sessions when expanded and
  every 10 seconds while open.
- After an application restart, records are read back from the sessions'
  persisted metadata; nothing depends on UI-local state.

## The global inventory

The full location-wide list no longer expands inside the sidebar (see
`SIDEBAR_SIMPLIFICATION.md`). One compact row remains — `All MCP servers ·
N/M connected`, with failed and needs-sign-in counts **always visible** —
and it opens `DialogMcp`, the MCP manager, which still exposes the complete
global inventory and all management actions.
