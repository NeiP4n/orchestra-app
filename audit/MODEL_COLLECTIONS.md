# Model Collections & Custom Endpoints — architecture and contracts

Date: 2026-11-04. Base: `main` @ `9dff107`. Delivered directly to `main`.

## What this is

Users can group models from any provider into named collections, point
Orchestra at their own API endpoints, discover or hand-enter the
endpoint's models, and pick collection models in the existing model
selector. Nothing here is a parallel registry: providers and models still
come from the one provider registry (models.dev catalog + provider
plugins + config providers), credentials still live in the credential
store, and collections are plain config data resolved against the live
registry at read time.

## Collections

- Schema: `Config.ModelCollection` in `packages/schema/src/config/model.ts`
  — `{id (slug), name, enabled, models: ["provider/model", …]}` (the
  favorites ref format), stored as `model_collections` in the global
  config document. It survives restarts because config does; the config
  Patch API gained a `model_collections` key (whole-list write, the
  favorites pattern) so every client writes it the same way.
- Pure logic: `packages/core/src/model-collections.ts` —
  normalize/create/rename/remove/toggle/add/remove with deduplication,
  plus `resolveCollections`/`pickerRefs`, which split a collection's refs
  into resolved and missing against a provider→models snapshot. Deleting
  a provider never rewrites a collection; its refs just stop resolving.
- Picker: the model dialog reads `model_collections` from the synced
  config (same channel as favorites) and renders each enabled collection
  as its own section between Feature and Recent; a model placed in
  Feature or an earlier collection is not repeated. Search behaviour is
  unchanged.

## Custom endpoints

An endpoint is a config provider entry marked `endpoint: true`
(additive optional field on `Config.Provider`), so the existing
ConfigProviderPlugin folds it into the registry like any configured
provider: `settings.baseURL`, a protocol package, declared models, and a
key-method integration under the same id. Protocol/compatibility modes
map to provider packages (`openai-compatible`, `openai`, `anthropic`,
`openrouter` in `ENDPOINT_PROTOCOLS`).

- **The API key never enters config.** The wizard stores it through
  `credential.create` (`{type: "key"}`) under the endpoint's integration
  id; deleting an endpoint removes its credentials too. Custom headers
  are ordinary config (they are not secrets by contract here; keys are).
- **Discovery / test connection**: `POST /api/provider/discover`
  (`provider.discover`) calls `packages/core/src/provider-discovery.ts`:
  validates the base URL (http/https only, no embedded credentials),
  GETs `{baseURL}/models` with the key as a Bearer header, 15 s timeout,
  and classifies every outcome — ok / auth (401·403) / http / unsupported
  (404·405, non-JSON, unrecognized shape) / network / timeout /
  invalid-url. "Unsupported" is a first-class result, not an error: the
  endpoint is reachable and the UI falls back to manual model entry.
  Response parsing accepts the OpenAI `{data:[{id}]}` shape, `{models}`,
  and bare arrays, deduplicating ids. Keys and header values never appear
  in results, messages or logs; the provider list handler's existing
  secret-stripping is untouched.
- When the request carries no key, the server resolves the endpoint's
  stored credential itself (the selected key credential — credential
  listings order the selected one last), so refresh/test of a saved
  endpoint never round-trips the secret to the client. The same
  implementation backs the plugin host's `provider.discover`, so promise
  plugins see the identical contract.
- Multiple endpoints may share a protocol/package: each is its own
  provider id (slug of its name, made unique), its own credential and
  its own model list. Refresh merges discovered ids into the entry's
  declared models without dropping manual ones or duplicating ids
  (`mergeEndpointModels`).

## Management UI (TUI)

`DialogModelCollections` (opened from the model picker's "Model
collections & endpoints" action):

- Collections: create/rename/enable/disable/delete; add models from the
  live registry list (searchable, per-provider categories); remove
  models; unavailable refs are marked, not hidden.
- Endpoints: a wizard (name → base URL → protocol → optional API key),
  a detail view with base URL/protocol/status, "Test connection & fetch
  models" (imports newly discovered models and reports count/latency),
  manual model add/remove, and delete (config entry + credentials).
  Status from the last test is shown on both the root list and the
  detail view; auth/network/unsupported failures show the classified
  message and leave manual entry available.

## Deliberate limits

- The web/desktop app gets collections and endpoints through the same
  config and registry (its model lists already render config providers;
  collections written by any client are shared), but the management
  wizard itself is TUI-only in this delivery.
- Discovery speaks the OpenAI-compatible `/models` convention; provider
  protocols without such an endpoint classify as `unsupported` and use
  manual entry — by design, per the mission.
- Endpoint entries are read from the merged config documents; writes go
  to the global document through the Patch API, like favorites.

## Tests executed for this delivery

- Core `provider-discovery.test.ts` (URL validation incl. embedded-
  credential rejection, path joining, response-shape parsing + dedupe,
  bearer header use, auth/unsupported/http/network/timeout
  classification, no key leakage into results, invalid URLs never
  fetched) and `model-collections.test.ts` (normalization, slug
  uniqueness, CRUD, dedupe on add, resolve/missing split, picker
  filtering, endpoint config carries no key material, discovery merge).
- Schema `model-collections.test.ts`: valid documents decode; bad ids,
  bad refs and a missing `enabled` are rejected.
- Regression sweep (config + plugin + model-plugins + meta-provider +
  discovery + collections suites, 727 tests): the only failures are the
  ones reproduced identically on clean main (OptimizePlugin ×4,
  PluginSupervisor ×2, freebuff RPC ×4 — all pre-existing) plus three
  load-flaky tests that pass individually in this worktree
  (session-compact ×2, skill registration ×1).
- Typechecks: schema and protocol clean; plugin clean; core at its
  pre-existing baseline (8, none in new files — the plugin-host test
  fixtures gained `discover` stubs for the widened ProviderDomain);
  server 111 with none in the changed handler; TUI shows only the core
  baseline via project references.
