# Template imports and creation failures

Identical imports previously used a fresh library ID for each import confirmation, even for the same file content. There is no Desktop scanner in this list: it combines the v1 and v2 local libraries. Import confirmation now reuses an existing exact content digest under a content-scoped lock. Listing hides historical exact-byte duplicates without deleting their files. Same-name templates with different configuration remain separate.

Destination model availability and built-in role mismatches previously had detailed internal diagnostics but both collapsed into TEMPLATE_FAILED. They now return distinct public error codes with bounded, localized explanations. Safety guards are unchanged: no fallback model or replacement role is invented. Filesystem path and occupied destination errors also have specific reasons; unknown failures remain unknown without exposing exception text.

The TUI displays one cause, not a generic failure sentence followed by another generic failure sentence. Recoverable confirmations keep their existing token and one retry instruction so a partial commit does not create another project.

Verified with a real in-memory server save/create flow, repeated file imports, a deliberately unavailable model, quoted filesystem paths, and a Windows-style absolute path rejected on a Linux server. Native Windows filesystem execution and the cause of any particular user's local failure are not established by these tests.
