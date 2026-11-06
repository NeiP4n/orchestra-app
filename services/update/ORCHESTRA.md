# Orchestra's own update service (variant (b)) — fork checklist

The built-in update host (variant (a), static manifests in `update/`, served from
`raw.githubusercontent.com`) is what the updater uses by default today. It has no
per-IP rollout and no publish authentication: anyone who can push to `main` can ship
an update. This file is the checklist for forking the Cloudflare Worker in this
directory (`services/update`, upstream OpenCode's update service) into Orchestra's own
service, with staged rollouts and authenticated publishes.

## Status (2026-11-06)

NOT deployed. Nothing in this directory is live for Orchestra: the worker name,
routes, D1 database, event stream and OIDC checks below still point at upstream
OpenCode. No `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` exists on the VM, so
the fork cannot be deployed from here — see "What is missing" at the bottom.

## What to change in this directory

1. `wrangler.jsonc`
   - `name`: `opencode-update` → `orchestra-update`.
   - `routes`: `update.opencode.ai` and `opencode.ai/update*` → Orchestra's own
     domain (e.g. `update.orchestra.example` — pick a domain the project controls).
     Remove the `opencode.ai` zone entries entirely.
   - `d1_databases`: `database_name` `opencode-update` → `orchestra-update`, and
     create a NEW D1 database (`wrangler d1 create orchestra-update`) — never reuse
     the upstream database id `2c010a96-811f-43d5-804d-7188534e5858`.
   - `pipelines` (`EVENTS` binding): the stream `251a89241c3a461c9007f6b6f345ed8b`
     is anomalyco's shared lake. Either point it at Orchestra's own stream or
     delete the binding (the worker must not send Orchestra's update events to
     upstream's lake — check `src/index.ts` for `EVENTS` uses first).
2. `src/index.ts`
   - OIDC audience `https://update.opencode.ai` → the new domain
     (`https://<new-domain>`).
   - Hostname check (`update.opencode.ai`) → the new domain.
   - Service name in `/` (`opencode-update`) → `orchestra-update`.
   - User-Agent regex `^opencode/...` → `^orchestra/...` (the CLI and desktop
     already send `orchestra/...` since D2).
   - Publish auth (`claims.repository !== "anomalyco/opencode"` and
     `workflow_ref` ending in `anomalyco/opencode/.github/workflows/publish.yml`):
     point both at `NeiP4n/orchestra-app` and the `release.yml` workflow —
     `publish.yml` is deleted, so the worker as-is would reject every Orchestra
     publish. The workflow that publishes must run with `id-token: write` and
     send the token to `/api/publish` (see `script/update-artifact.ts`, which
     still posts to `https://opencode.ai/update/api/publish` — retarget it too).
3. `migrations/`: keep — they define the D1 schema for the new database.
4. `README.md`: update the protocol doc's domain and repository names.

## What to change outside this directory

- `ORCHESTRA_UPDATE_URL`: set it to `https://<new-domain>` (env var, or the code
  default in `packages/cli/src/services/updater.ts` — `DEFAULT_UPDATE_URL` — and
  the desktop default in `packages/gui-extensions/src/updater/platform.ts`).
  The static host (variant (a)) stays as the fallback when the Worker is down:
  the updater falls back to GitHub releases when the service fetch fails.
- `script/update-artifact.ts`: retarget the publish URL and OIDC audience to the
  new domain, and call it from `release.yml` after `gh release create` (or keep
  publishing to the Worker out of band — the static manifests in `update/` are
  refreshed by `release.yml` either way).
- Rollout: the Worker already implements channel rollouts by IP
  (SHA-256 of channel+IP, duration in hours, default 0 — see `README.md`).
  A `beta` release to the Worker rolls out gradually; the static host cannot do
  that, so canary via the Worker is the reason to do this fork at all.

## What is missing to enable it

- A Cloudflare account the project controls, with Workers + D1 enabled.
- `CLOUDFLARE_API_TOKEN` (Workers + D1 + zone edit scope) and
  `CLOUDFLARE_ACCOUNT_ID` — as repository secrets for the deploy step, and locally
  for the first `wrangler deploy` / `wrangler d1 create`.
- A domain for the service (DNS zone in that Cloudflare account).
- A GitHub App or token with `id-token: write` for the publish OIDC flow
  (the existing `ORCHESTRA_APP_ID` / `ORCHESTRA_APP_SECRET` pair used by
  `setup-git-committer` can serve, but the Worker checks the workflow ref —
  update it per step 2 above).

## How to verify the fork

1. `cd services/update && bun run deploy` (with the token set) — must succeed.
2. `curl https://<new-domain>/` returns `{"service":"orchestra-update"}`.
3. Publish a test release through `release.yml` with the Worker publish step
   enabled, then `curl https://<new-domain>/latest/cli/npm` returns the new
   version, and `orchestra upgrade` on a test install picks it up.
4. Delete the test release and its manifests afterwards.
