# Project debug recording

Off by default. In a local TUI, open a project's chat, then click `Debug OFF` on the bottom bar (or open Tools) and click
`Project recording: OFF` to turn it on. The visible `REC debug` indicator opens
the same controls. Click ON again to stop. Remote TUI connections do not change
files on the TUI machine.

Alternatively, launch the local backend with `ORCHESTRA_PROJECT_DEBUG=1`.
A project's saved OFF setting overrides that environment default.

All owned sessions of that project share `.orchestra/project-debug.jsonl`.
Records include timestamps, session IDs, roles, event types, user and synthetic
messages, final assistant text, tool inputs/results, shell commands/results and
execution failures. Streaming fragments and system instructions are not copied.
The recording starts with new events, not old history. It is a live diagnostic
feed, not a crash-safe audit trail. Paused/off periods cannot be recovered from it.

Only local files are written. Nothing is uploaded automatically. Tools includes
Copy debug log path and Open debug log folder so you can inspect the file before
sharing it. Secret fields, known secret environment values, credential patterns
and authentication headers are redacted before writing. Redaction is best effort:
private business or personal text remains in the log. Review it before sharing.
No feature can promise to identify every arbitrary secret in free-form text.

The active file has a 10 MiB cap and one rotated backup (`.1`). Oversized events
are replaced by an omission record. Rotation discards older backup data. Files
are created with owner-only permissions where the OS supports them. Symbolic and
hard-linked log/config destinations are refused. Recording paths are added to
`.orchestra/.gitignore`. Keep both files private; turning OFF does not delete
previously recorded data. Delete the log and backup yourself when no longer needed.
