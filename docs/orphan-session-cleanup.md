# Orphan-session cleanup

The local TUI's left panel has `Clear orphans` below `Clear all sessions`.
It asks the backend for a dry-run count, then asks for confirmation before
sending a one-use preview token back. A preview expires after five minutes.

This is deliberately narrower than deleting everything not drawn on screen.
A candidate must be a non-archived leaf session whose parent no longer exists,
with no existing project owner or containing project, no group-supervisor marker,
and no browser role/title. Root chats, the currently open chat, sessions with
children, queued input, process-active execution and persisted execution claims
are protected. A collapsed group or a paginated/filtered list is never evidence
that a session is an orphan.

The backend repeats eligibility checks before each deletion. An idle reservation
prevents a new execution from racing the deletion; inbox admission is serialized
and storage changes run in a transaction. Only the preview's original IDs may be
deleted. New candidates require another count and confirmation. Sessions that
became active or acquired ownership are skipped. No project, rule or browser
record is deleted. Remote TUI connections do not show the control, and the API
refuses requests with non-loopback peers or non-local hostnames.

The result reports deleted and skipped counts. This cannot be undone. Use this
for actual abandoned child-session records, not as a way to empty archives or
remove ordinary root chats that happen not to fit in the panel.
