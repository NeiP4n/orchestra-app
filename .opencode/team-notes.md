# Team notes

Durable facts about working in this fork. Keep short and factual.

## Probing config without touching the live global config

- `ORCHESTRA_CONFIG` is honored by the server process path only; `opencode debug config` ignores it and keeps reading `C:\Users\Isako\.config\opencode`.
- `ORCHESTRA_CONFIG_DIR` does change `opencode debug paths`, but the config loader of `debug config` / `models` still resolved the real global dir — so env-var isolation is not a reliable way to test a draft provider block. Test against the real config, with a `.bak-<timestamp>` sibling copy.
- `opencode debug config` prints every config source with its decoded JSON: that is the fastest way to see which keys the running binary actually keeps.

## Provider config shape (the docs are stale)

- `packages/web/src/content/docs/providers.mdx` documents the V1 shape: top-level `provider`, `npm`, `options`. The live schema is V2: top-level `providers`, `package`, `settings`. V1 keys still work through the migration in `packages/core/src/v1/config/migrate.ts` (`migrateStandardProvider`: `npm` -> `package`, `options` minus `headers`/`body` -> `settings`).
- Unknown keys are silently dropped, not rejected: the pre-existing `providers.openai.options` block decodes to `"openai": {}`.
- Model keys must equal the exact upstream id. A custom provider id maps to a provider option `provider` in the request body (`aisdk-native.ts` `rewrite`), so upstreams must ignore that extra field.

## Keyless providers (no API key)

- Do **not** write a junk `apiKey` placeholder. `hasConfiguredAuth` (`packages/core/src/model-resolver.ts:431`) treats any non-empty string as a real credential, and then a bogus `Authorization: Bearer ...` goes out.
- Omitting `apiKey` is the working idiom, and it is not the AI SDK's doing: any config-declared provider gets `activation = "enabled"` (`packages/core/src/config/plugin/provider.ts:67`), and when there is no stored credential and no configured auth the resolver replaces the route auth with `Auth.none` (`model-resolver.ts:386-392`), so the request leaves with no `Authorization` header.
- `apiKey: ""` is stripped before the package sees it (`prepareRuntimeModel`, `model-resolver.ts:259`) and only exists to suppress an injected empty value; for keyless relays simply leave the key out.
- Default model limits are `{ context: 200000, output: 32000 }` (`packages/schema/src/model.ts:162`). The output reservation is added to the prompt, so a real smaller context window needs an explicit per-model `limit`.

## Headless equivalents of TUI commands

- `/models` -> `opencode models`; one-shot inference -> `opencode run -m <providerID>/<modelID> "prompt"`; resolved config -> `opencode debug config`; global paths -> `opencode debug paths`.
- `opencode --help` also has `serve`, `api`, `auth`, `service`, `reload`.

## Shell on this machine

- The shell is Nushell. `$env:FOO = "x"` does not reliably reach child processes; use `with-env { FOO: 'x' } { ... }` instead.
- No `pwsh` and no `rg` binary; `grep`/`glob` tools work, the hub's `search.content` entry does not.
- `2>&1` is invalid; use `| complete` to get stdout, stderr and exit code of a command that exits non-zero (for example `git diff --no-index`).

## TUI Network & Free Models

- Public proxy probe in `packages/tui` checks only `api.ipify.org` by default; upstream target probe is null unless configured via `ORCHESTRA_PROXY_PROBE_HOST`. Rotator is inert without `ORCHESTRA_ENABLE_PROXY_ROTATOR=1`.
- `freeZenModels` in `zen-models-core.ts` falls back to `kilo-free` and local providers (`ollama`, `local`, `lmstudio`, `llamacpp`) when `opencode` is absent. Docs command in `app.tsx` defaults to repo README or `ORCHESTRA_DOCS_URL`.

## Models catalog source

- `defaultSource` is `https://models.dev` (overridden by `ORCHESTRA_MODELS_URL`). Provider `opencode` is stripped in `ModelsDev.normalize` and `script/update-models-snapshot.ts`.

## Google Antigravity (Cloud Code Assist)

- Uses `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`, wraps `{ project, model, request }`, and unwraps `data: {"response": ...}` SSE frames through `GeminiCloudCode` protocol.
