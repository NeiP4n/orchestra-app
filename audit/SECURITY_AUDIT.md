# Security Audit — Forensic Audit V2 (partial)

Scope actually covered in this pass (targeted, not a full threat-model sweep):

- **LAN room access control.** Join gate verified in
  `packages/server/src/handlers/room.ts`: rooms cannot be shared unless the
  host sets a server password; join codes are required, checked and expire;
  guests are capped; the ban check (`Room.banned`) now reads through the
  paginated scan fixed in PR #31, so bans past the first 1000 KV rows are
  enforced again (F-ROOM-1 was an access-control failure: banned devices
  could rejoin once a room accumulated >1000 bans). Member list remains
  capped at 100 live members by design.
- **MCP permission boundary.** F-MCP-1 closes a real enforcement gap: numeric
  MCP budgets existed only as metadata and prompt text; a worker could exceed
  them on allowed servers. Dispatch now enforces allowlist, total and
  per-server caps, and a malformed limit fails closed rather than silently
  ungating the session.
- **Error surface.** Location defects return bare 500s with no body; this is a
  diagnosability problem (see RESIDUAL_RISKS.md), not an information leak —
  no stack traces or internals are sent to clients.

Not covered: full authentication/authorization sweep of every endpoint, PTY
and WebSocket authorization, plugin/MCP supply chain, installation scripts.
No claims are made about them here.
