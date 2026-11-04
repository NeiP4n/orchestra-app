# Sidebar Simplification — what was removed, what stayed

Date: 2026-11-04. Base: `main` @ `9ffabbd`.

## Review scope

The complete right sidebar: the session header (identity, hide control),
the session network strip, the `sidebar.content` slot plugins (context,
DoD, MCP), and the footer slot. The MCP plugin was the clutter source; the
other panels carry information the operator acts on (context usage and
compaction thresholds, DoD progress) and were left functionally intact.

## Removed

- **The permanently listed global MCP inventory.** The old MCP section
  rendered every configured server as a row (name + status word) whenever
  any server existed — a location-wide list dominating a per-session panel,
  duplicating the MCP manager dialog, and implying those servers belonged
  to the session. Replaced by the per-session assignment view and a single
  compact global row (see `TEAM_MCP_SIDEBAR.md`).
- **Duplicated status signalling in the global list**: the old section
  showed a colored dot, a bold name and a status word per server, plus a
  separate collapsed attention line. In the new panel, attention counts
  (failed / needs sign-in) live on the single global row and are always
  visible; per-server states appear only for servers actually assigned to
  the session, where they matter.
- **Redundant counts**: the old header repeated "{n}/{total} connected"
  over a fully expanded list that already showed each state. The global
  row keeps the count once; the session header counts assignments, not
  inventory.

## Kept (deliberately)

- Current session identity and the hide control; the session network
  strip (it visualizes this session's place in the team, which the team
  MCP section complements).
- Context panel (usage, thresholds, scopes) and DoD panel (stage/DoD
  progress) — essential workflow information, already compact summaries
  with expandable detail.
- Full global MCP inventory and management — in the MCP manager dialog
  (`DialogMcp`), one click from the compact row and from any assigned row.
- Error and authorization visibility: failed and needs-sign-in states are
  shown on assigned rows and in the global row's always-visible counts.

## Shape rules the new panel follows

- Compact summaries first, expandable detail second (team assignments are
  collapsed by default; a large team costs one line).
- One fact per line; no decorative separators; names truncate instead of
  overflowing at narrow widths (`wrapMode="none"`, `truncate`, `minWidth=0`
  on the name column, fixed-shrink status column).
- The panel is never empty for MCP: with no servers and no assignment it
  still states the session's assignment state ("Not assigned yet").
