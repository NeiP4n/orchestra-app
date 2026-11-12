# Template imports and creation failures

Identical imports previously used a fresh library ID for each import confirmation, even for the same file content. There is no Desktop scanner in this list: it combines the v1 and v2 local libraries. Import confirmation now reuses an existing exact content digest under a content-scoped lock. Listing hides historical exact-byte duplicates without deleting their files. Same-name templates with different configuration remain separate.

Destination model availability and built-in role mismatches previously had detailed internal diagnostics but both collapsed into TEMPLATE_FAILED. They now return distinct public error codes with bounded, localized explanations. Safety guards are unchanged: no fallback model or replacement role is invented. Filesystem path and occupied destination errors also have specific reasons; unknown failures remain unknown without exposing exception text.

The TUI displays one cause, not a generic failure sentence followed by another generic failure sentence. Recoverable confirmations keep their existing token and one retry instruction so a partial commit does not create another project.

Verified with a real in-memory server save/create flow, repeated file imports, a deliberately unavailable model, quoted filesystem paths, and a Windows-style absolute path rejected on a Linux server. Native Windows filesystem execution and the cause of any particular user's local failure are not established by these tests.

## Reviewed built-in role migration

When creation reports a built-in role mismatch, the TUI offers a separate review action. It asks the server to prepare a prospective copy using only its current `orchestrator` and `team-browser-agent` definitions. The preview lists each changed role, its changed fields, and SHA-256 fingerprints before and after. The Create button is a separate confirmation; no project is created by requesting the preview.

The original library entry and exported file are never edited. Project rulebooks, custom roles, prompts, skills and schedules stay byte-for-byte in the prospective template; schedules still import paused. A missing or ambiguous current built-in fails closed. Runtime roles outside the reserved built-ins are not migrated. Model availability and other destination checks still apply. Confirmation binds the source digest and revalidates destination definitions; a changed source or changed runtime is refused.

Rows include a short content digest, so same-name templates with different settings are distinguishable. The current UI does not guess export times that were never stored.

The reviewed migration also covers existing runtime snapshots for the standard built-in build, plan, general, explore, compaction, title and summary identities. A template can contain those in addition to the two Orchestra core roles. These snapshots are replaced only in the prospective template with the destination's current local definitions, never by importing the foreign permissions. Runtime field differences (system, permissions, request, model, etc.) are named in the review. Custom runtime identities remain blocked and are not rewritten. An old server that omits comparison metadata now gets an explicit update/restart message instead of silently rendering no diff.
