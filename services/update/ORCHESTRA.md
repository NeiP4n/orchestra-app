# Orchestra's own update service (variant (b)) — fork checklist

The built-in update host (variant (a), static manifests in `update/`, served from
`raw.githubusercontent.com`) is what the updater uses by default today. It has no
per-IP rollout and no publish authentication: anyone who can push to `main` can ship
an update. This file is the checklist for forking the Cloudflare Worker in this
directory (`services/update`, upstream OpenCode's update service) into Orchestra's own
service, with staged rollouts and authenticated publishes.

## Status (2026-11-07)

Code migrated (stage 2 of the opencode removal): the worker is now
`orchestra-update` — service name, User-Agent `^orchestra/`, publish auth
retargeted to `NeiP4n/orchestra-app` (repo ID `1431411182`, owner ID
`139688546`) and `.github/workflows/release.yml`, the upstream event-lake
binding deleted, the files bucket / publish URL moved to
`ORCHESTRA_UPDATE_FILES_BUCKET`, `ORCHESTRA_UPDATE_FILES_BASE_URL` and
`ORCHESTRA_UPDATE_PUBLISH_URL` in `script/update-artifact.ts` (no caller
wires them yet).

NOT deployed. Nothing in this directory is live for Orchestra: there is no
Orchestra domain yet, so the audience/hostname is the placeholder
`update.orchestra.example` (in `src/index.ts`, `wrangler.jsonc` and the
README) and `wrangler.jsonc` has no D1 `database_id` — create one with
`wrangler d1 create orchestra-update` and fill it in. No
`CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` exists on the VM, so the
fork cannot be deployed from here — see "What is missing" at the bottom.

## What was changed in this directory (done 2026-11-07)

1. `wrangler.jsonc` — done.
   - `name`: `opencode-update` → `orchestra-update`.
   - `routes`: the `opencode.ai` zone entries are removed; `workers_dev` is on
     until the project owns a domain (then add a route for it, e.g.
     `update.orchestra.example`).
   - `d1_databases`: `database_name` `opencode-update` → `orchestra-update`;
     `database_id` left out on purpose — create a NEW D1 database
     (`wrangler d1 create orchestra-update`) and fill it in. The upstream
     database id `2c010a96-811f-43d5-804d-7188534e5858` is never reused.
   - `pipelines` (`EVENTS` binding): deleted — the stream
     `251a89241c3a461c9007f6b6f345ed8b` was anomalyco's shared lake, and the
     `EVENTS` send in `src/index.ts` is deleted with it.
2. `src/index.ts` — done.
   - OIDC audience → `https://update.orchestra.example` (placeholder — no
     Orchestra domain exists yet; replace with the real domain when it does,
     together with the hostname check and the publish URL).
   - Hostname check → `update.orchestra.example`.
   - Service name in `/` → `orchestra-update`.
   - User-Agent regex `^opencode/...` → `^orchestra/...` (the CLI and desktop
     already send `orchestra/...` since D2).
   - Publish auth → `NeiP4n/orchestra-app` (repo ID `1431411182`, owner ID
     `139688546`) and `.github/workflows/release.yml`. The workflow that
     publishes must run with `id-token: write` and send the token to
     `/api/publish` (see `script/update-artifact.ts`).
3. `migrations/`: keep — they define the D1 schema for the new database.
4. `README.md` — done: protocol doc now uses `update.orchestra.example`,
   `orchestra` User-Agent/distribution, and the NeiP4n repository; the
   request-logging section is replaced with a note that logging is gone.

## What to change outside this directory

- `ORCHESTRA_UPDATE_URL`: set it to `https://<new-domain>` (env var, or the code
  default in `packages/cli/src/services/updater.ts` — `DEFAULT_UPDATE_URL` — and
  the desktop default in `packages/gui-extensions/src/updater/platform.ts`).
  The static host (variant (a)) stays as the fallback when the Worker is down:
  the updater falls back to GitHub releases when the service fetch fails.
- `script/update-artifact.ts` — done in code, not wired: the publish URL now
  comes from `ORCHESTRA_UPDATE_PUBLISH_URL` (required; throws when unset) and
  the OIDC audience is that URL's origin; the files bucket/base URL come from
  `ORCHESTRA_UPDATE_FILES_BUCKET` / `ORCHESTRA_UPDATE_FILES_BASE_URL`
  (required for uploads). Nothing calls `publish`/`upload` yet — call them
  from `release.yml` after `gh release create` (or keep publishing to the
  Worker out of band — the static manifests in `update/` are refreshed by
  `release.yml` either way).
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
