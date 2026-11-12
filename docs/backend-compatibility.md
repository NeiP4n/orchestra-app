# TUI and background server compatibility

The TUI queries `/api/info` at startup and after a managed reconnect. Server version and optional capabilities are authoritative; a matching package version alone does not prove a route exists. New servers advertise `projectDebug` and `orphanCleanup`. A missing orphan capability produces an upfront restart/update hint in the local project panel and prevents the prepare request. If info is unavailable, compatibility remains unknown and the normal request/error path applies.

Cleanup 404 responses show an update/restart hint rather than raw `UnexpectedStatus: 404`. This does not claim that a partial clear-all removed nothing. A 404 alone does not prove that the user's server was stale.

Removing a project removes Orchestra records and owned chat history. It does not erase the project directory, `.orchestra` files, or exported `.orchestra-template` files. The edit dialog says so before its two-click removal. No filesystem deletion was added.

### TUI safe hover foregrounds

The shared hover surface is contrast-corrected and may differ from a theme's authored action background. Its foreground must be chosen against that actual surface, not from an inverse `text.action.*.hovered` token. `hoverForeground` checks a 4.5:1 floor and falls back to readable theme text. Delete-all DoD, clear-sessions and clear-orphans now use it, as do the same hover patterns in project rows, notes, filters and navigation. Authored selected/focused/disabled states keep their corresponding authored backgrounds and remain covered by the theme state-pair contrast audit.

### Antigravity OAuth configuration

Integration discovery exposes the code `antigravity-client-secret` only when the configured Antigravity OAuth method lacks its local client-secret environment configuration. It never returns the environment value. The TUI leaves the method visible with a short RU/EN warning and prevents starting it; other Google methods are not blocked. A stale-client/server race maps the known missing-config failure to the same warning rather than a raw red English toast.

Google's Desktop OAuth documentation permits optional client secrets for public clients with PKCE: https://developers.google.com/identity/protocols/oauth2/native-app . That does not change the registration of the existing Antigravity client. A token-endpoint probe with that existing client ID, no secret, PKCE verifier and a deliberately invalid non-user code returned HTTP400 `invalid_request`, `client_secret is missing.` No user authorization or token was used. PKCE is already present in the implementation; removing the local guard would only defer this failure. No client credential is embedded or sourced from third-party applications.

#### Your own OAuth application

Set `ORCHESTRA_ANTIGRAVITY_CLIENT_ID` to your own registered Google OAuth client ID in the server process environment. For a confidential client, also set its matching `ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET`. Restart the server. Both native and plugin Antigravity paths use the chosen ID for authorization, code exchange and refresh. The loopback callback remains `http://localhost:51121/oauth-callback` and must match the client registration. Never paste secrets into chat or commit them.

An explicitly supplied non-default client may try public-client PKCE without a secret. The token endpoint determines whether that registration accepts it; Orchestra neither inserts a fallback secret nor silently retries another application. The old default registration still requires a secret. Client ID alone is not proof of Antigravity API entitlement: consent/scopes and the resulting account/API permissions can still be rejected by Google. Switching OAuth clients requires reconnecting accounts; old refresh tokens are bound to the client that issued them. Real sign-in and API entitlement with a user's own registered client remain unverified until that user tries the flow.

Explicit focused/selected backgrounds on shared HoverAction buttons now survive pointer hover. Their text was paired with that authored background; replacing only the background caused invisible modal confirm/cancel labels. DialogSelect footer actions likewise retain their actual focused or disabled background. Rendered regression checks cover primary/secondary/destructive and base/hover/focus/selected/pressed/disabled for every registered theme/mode, with real mouse entry, in addition to the palette state audit and the actual clear-all confirmation modal.

#### Local gitignored file instead of environment variables

In the directory from which the server is launched, run `node script/init-oauth-client.mjs` (from the Orchestra repository) to create `.orchestra/credentials.env` exclusively with mode0600 (directory0700). Existing files are never overwritten. Edit it locally:

```dotenv
ORCHESTRA_ANTIGRAVITY_CLIENT_ID=your-own-client-id
ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET=your-own-client-secret
```

Omit or leave the second line empty only for your own public client. The server reads only these two names, without shell expansion; process environment variables override the file. Restart after editing. Both native and plugin paths read the same file. The file is explicitly gitignored; CI rejects any diff that includes this private filename even if force-added, before scanning added lines for other secrets. Symlink files/directories and oversized/non-regular files are refused. File permissions remain the local operator's responsibility when creating it manually, especially Windows ACLs. No historical credential is restored. Local server-process configuration does not travel with a portable project template.
