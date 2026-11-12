# TUI and background server compatibility

The TUI queries `/api/info` at startup and after a managed reconnect. Server version and optional capabilities are authoritative; a matching package version alone does not prove a route exists. New servers advertise `projectDebug` and `orphanCleanup`. A missing orphan capability produces an upfront restart/update hint in the local project panel and prevents the prepare request. If info is unavailable, compatibility remains unknown and the normal request/error path applies.

Cleanup 404 responses show an update/restart hint rather than raw `UnexpectedStatus: 404`. This does not claim that a partial clear-all removed nothing. A 404 alone does not prove that the user's server was stale.

Removing a project removes Orchestra records and owned chat history. It does not erase the project directory, `.orchestra` files, or exported `.orchestra-template` files. The edit dialog says so before its two-click removal. No filesystem deletion was added.

### TUI safe hover foregrounds

The shared hover surface is contrast-corrected and may differ from a theme's authored action background. Its foreground must be chosen against that actual surface, not from an inverse `text.action.*.hovered` token. `hoverForeground` checks a 4.5:1 floor and falls back to readable theme text. Delete-all DoD, clear-sessions and clear-orphans now use it, as do the same hover patterns in project rows, notes, filters and navigation. Authored selected/focused/disabled states keep their corresponding authored backgrounds and remain covered by the theme state-pair contrast audit.

### Antigravity OAuth configuration

Integration discovery exposes the code `antigravity-client-secret` only when the configured Antigravity OAuth method lacks its local client-secret environment configuration. It never returns the environment value. The TUI leaves the method visible with a short RU/EN warning and prevents starting it; other Google methods are not blocked. A stale-client/server race maps the known missing-config failure to the same warning rather than a raw red English toast.

Google's Desktop OAuth documentation permits optional client secrets for public clients with PKCE: https://developers.google.com/identity/protocols/oauth2/native-app . That does not change the registration of the existing Antigravity client. A token-endpoint probe with that existing client ID, no secret, PKCE verifier and a deliberately invalid non-user code returned HTTP400 `invalid_request`, `client_secret is missing.` No user authorization or token was used. PKCE is already present in the implementation; removing the local guard would only defer this failure. No client credential is embedded or sourced from third-party applications.
