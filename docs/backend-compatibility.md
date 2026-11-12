# TUI and background server compatibility

The TUI queries `/api/info` at startup and after a managed reconnect. Server version and optional capabilities are authoritative; a matching package version alone does not prove a route exists. New servers advertise `projectDebug` and `orphanCleanup`. A missing orphan capability produces an upfront restart/update hint in the local project panel and prevents the prepare request. If info is unavailable, compatibility remains unknown and the normal request/error path applies.

Cleanup 404 responses show an update/restart hint rather than raw `UnexpectedStatus: 404`. This does not claim that a partial clear-all removed nothing. A 404 alone does not prove that the user's server was stale.

Removing a project removes Orchestra records and owned chat history. It does not erase the project directory, `.orchestra` files, or exported `.orchestra-template` files. The edit dialog says so before its two-click removal. No filesystem deletion was added.
