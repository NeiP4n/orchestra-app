# Transport Audit — Forensic Audit V2 (partial)

- LAN rooms: join/password/code/ban/member-cap paths read and verified in
  `packages/server/src/handlers/room.ts` and `packages/core/src/room.ts`
  (see SECURITY_AUDIT.md and F-ROOM-1).
- HTTP API error surface: undeclared endpoint failures surface to clients as
  `UnexpectedStatus` with only the status code; declared errors decode by tag.
  Location-scoped endpoints declare 400/401/404 (+503 on location.reload).
- Not inspected in this pass: WebSocket/SSE lifecycle, PTY and persistent PTY
  framing/backpressure, reconnection behaviour. No claims are made.
