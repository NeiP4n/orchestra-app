# Orchestra Update

The update Worker serves all selected artifacts for a channel.

```sh
curl 'https://update.orchestra.example/api/latest'
curl 'https://update.orchestra.example/api/latest/cli'
curl 'https://update.orchestra.example/api/latest/cli/npm'
```

The Worker is served at its own hostname (`update.orchestra.example` is a
placeholder — no Orchestra domain exists yet; see ORCHESTRA.md). Admin forms,
pagination, and redirects preserve the request's mount.

## Desktop update feeds

Electron updater manifests are available at `/api/<channel>/desktop/<distribution>/<filename>`:

```sh
curl 'https://update.orchestra.example/api/beta/desktop/orchestra/latest-mac.yml'
```

Use `latest.yml` for Windows, `latest-mac.yml` for macOS, `latest-linux.yml` for Linux x64,
and `latest-linux-arm64.yml` for Linux ARM64. The distribution selects the stored download
URLs (`orchestra` or `github`). Each manifest includes the selected artifact's version,
file URLs, SHA-512 checksums, sizes, and release date. Existing minimum-version selection
and `current`/User-Agent handling also apply to these feeds.

## Channel rollouts

Set each channel's rollout duration in hours on the admin page. All channels default
to `0` (immediate); fractional hours are supported. For example, `6` makes a release
available to roughly half of IPs after three hours and all IPs after six hours.

Eligibility uses the original publication time (`time_created`) and a SHA-256 hash
of the channel and Cloudflare's `CF-Connecting-IP`. Each IP keeps the same rollout
position across releases in that channel. Requests without this header wait for
the full duration. The retired `next` channel is not configurable; `/api/next`
remains a compatibility alias for `/api/beta`, including its rollout settings.

Until the active release is eligible, callers receive the newest eligible artifact
published before it, for the same name and distribution. This also handles overlapping
rollouts. Earlier inactive releases can be fallbacks, including manually deactivated
releases; releases newer than the active release cannot. If no eligible artifact
exists, it is omitted from listings and individual artifact requests return 404.

Minimum releases bypass rollout for clients that need them, and identified clients
are not sent a fallback below their configured minimum. Rollout applies to all JSON
endpoints and desktop manifests. Responses, including unavailable artifacts, are not cached.

Duration changes apply immediately to existing releases. Manual activation uses the
original publication time too; set the duration to `0` to make it immediate.
Apply the `0004_channel_rollout.sql` migration before deploying.

## Minimum releases

Each channel/name/distribution can mark one retained artifact as `minimum`, independently
of its `active` artifact. Set or clear it from the admin page. Publishing a new active
release preserves the minimum marker.

Clients send their running version as `?current=<version>` and use the CLI's default
`User-Agent: orchestra/<channel>/<version>/cli`. When `current` is absent, the service
parses that User-Agent or the older `orchestra/<version>` format.
The caller's channel comes from the default User-Agent, or from a preview version
such as `0.0.0-beta-18955` when that channel is absent. If an identified caller channel
differs from the requested channel, the service serves the active release without
applying the minimum. Historical `next` and `beta` count as the same channel.
A caller below the minimum receives that exact
artifact; callers at or above it receive the active artifact. An unparseable caller
version receives the minimum. Requests with neither version source receive the active
artifact. All three public API paths apply the same selection and use `Cache-Control:
no-store` because responses can depend on the User-Agent.

Version comparison uses semver, normalizing preview run numbers to numeric prerelease
identifiers and historical `next` versions to `beta`. The retired `/api/next`
channel transparently resolves to `beta` for older clients.

Choose a minimum that older clients can install and that can itself consume the active
release.

The admin page must be protected by a Cloudflare Access self-hosted application
before the Worker is exposed:

- Public hostname/path: `update.orchestra.example/admin*`
- Policy: allow the Orchestra team identity group

Configure Access before deploying the new Worker route. Until the project owns a
domain the Worker runs on workers.dev (`workers_dev` is on); add a routes entry
for the real domain when it exists.

## Request logging

None. The upstream Worker's `EVENTS` Pipelines binding sent every request to
the vendor's shared data lake; that binding was deleted in the Orchestra fork
(there is no Orchestra lake stream) and the Worker no longer emits request
events.

## Publishing

The publish workflow also registers direct binary downloads with distribution
`orchestra`, after uploading every file to the files bucket configured by
`ORCHESTRA_UPDATE_FILES_BUCKET` / `ORCHESTRA_UPDATE_FILES_BASE_URL`
(see `script/update-artifact.ts` — no bucket exists yet):

```sh
curl 'https://update.orchestra.example/api/dev/cli/orchestra'
curl 'https://update.orchestra.example/api/dev/cli-node/orchestra'
curl 'https://update.orchestra.example/api/latest/desktop/orchestra'
```

`metadata.files` maps each filename to its direct
`<files-base-url>/bin/<version>/<filename>` URL, SHA-256 checksum, and
byte size. Desktop records additionally contain `metadata.manifests`, with
the CDN URLs and the original Electron update checksums. Existing `npm`,
`github`, and `aur` distributions are published independently.

GitHub Actions publishes artifacts through `POST https://update.orchestra.example/api/publish`
(the publish URL comes from `ORCHESTRA_UPDATE_PUBLISH_URL`)
using a short-lived OIDC token whose audience is the publish URL's origin.
The Worker accepts only tokens signed by GitHub for repository
`NeiP4n/orchestra-app` (ID `1431411182`, owner ID `139688546`) and
`.github/workflows/release.yml` on configured publishing refs.

Apply migrations and deploy from this directory:

```sh
bun run db:migrate
bun run deploy
```
