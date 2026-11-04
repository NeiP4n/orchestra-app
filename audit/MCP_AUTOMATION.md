# MCP Automation — Autonomous Acquisition, Lifecycle and Role Allocation

Branch: `mcp-role-orchestration`. New module: `packages/core/src/mcp/acquire.ts`
(`McpAcquire`), wired into the `sessions` tool as `action acquire_mcp`.

## 1. What existed, and the gap

| Piece | State found |
|---|---|
| Curated catalog | `packages/core/src/mcp/catalog.ts` — 17 entries with description, usage, runtime (`npx`/`uvx`), platform filter, required env vars, ready config. `missing(name, config)` computes unprovided credentials |
| Connection lifecycle | `packages/core/src/mcp/index.ts` — Location-scoped service: `servers()`, `add()` (override + reload), `connect()` (stop+start under a per-server lock), `disconnect()`, `remove()`, `tools()`, budget-gated `callTool()` |
| Health/circuit breaking | In `catalog.ts`: `McpCircuitBreaker`, `healthcheckServer`, `isServerAvailable` |
| Installation UX | **Humans only**: the TUI registry (`devtools-registry.tsx`) writes global config; `mcp_forge` builds *custom* servers |
| Orchestrator-facing acquisition | **Did not exist.** No tool let the Orchestrator select, install, connect or verify a catalog server |

## 2. Selection (`McpAcquire.select`)

Deterministic keyword scoring over the catalog for a capability need stated
in words ("browser automation", "library documentation"):

- Fields weighted: id+name ×3, description ×2, usage ×1; whole-token matches.
- Ties break by entry id — the same need always selects the same server.
- Platform-filtered (`McpCatalog.forPlatform`); non-matches return empty —
  the tool then says native tools may suffice and `mcp_forge` is the last
  resort, never the first (selection priority: native → installed/healthy →
  catalog → disconnected → forge).

## 3. Readiness classification (`McpAcquire.classify`)

One honest state per server, computed from the catalog entry + live service
status + **actually discovered tools**:

| State | Meaning |
|---|---|
| `healthy` | Connected **and** ≥1 tool discovered |
| `degraded` | Connected but no tools discovered |
| `configured` | Installed, still starting (`pending`) |
| `needs_auth` | Service reports `needs_auth`, or required env vars are unprovided |
| `failed` | Last start attempt failed (service error text preserved) |
| `disabled` | Operator disabled it |
| `not_installed` | In the catalog, not configured |
| `unavailable` | Unknown id, or not offered on this platform |

A registered/configured server is never reported as usable; a connected
server with zero discovered tools is `degraded`, not `healthy`.

## 4. Acquisition (`McpAcquire.ensure`) — smallest sufficient work

1. `healthy`/`degraded` → **reuse**, no service mutation.
2. `configured` → `connect()` (settles the start), re-classify.
3. `not_installed` → validate first: platform (in classify), required
   credentials via `McpCatalog.missing` → if any are missing, stop with
   `needs_auth` naming the **variables** (never values, never invented);
   runtime presence via `which(npx|uvx)` → if absent, `failed` with the
   reason. Only then `add(id, entry.config)` (the existing configuration
   path — an override + reload) and `connect()`.
4. Verify: re-read `servers()` + `tools()` and classify the *result*. An
   install whose server fails to start returns `failed` with the service's
   own error — never a success claim.
5. `disabled` → reported, **never re-enabled**: disabling is the operator's
   decision. `failed` → reported, not silently retried (no retry storms);
   the Orchestrator sees the cause and decides.

`action` in the result records what the call actually did:
`reused | connected | installed | none`.

## 5. Authentication and secrets

- No credential is ever invented, generated or logged. Missing variables are
  surfaced by name; providing them stays with the operator through the
  existing config/env channels, and OAuth servers follow the service's
  existing `needs_auth` flow (sign-in from /mcps).
- Catalog entries that need no credentials (context7, playwright, git, …)
  install autonomously; entries needing keys (brave-search →
  `BRAVE_API_KEY`, sentry → `SENTRY_ACCESS_TOKEN`) stop at `needs_auth`
  *before* any installation is written.

## 6. Role allocation — acquisition grants nothing

Ownership boundaries are unchanged and explicit:

- **Global lifecycle** (this module + MCP service): whether a server exists
  and is connected. Location-scoped, shared.
- **Role boundary** (`role-profiles.ts`, authoritative): which servers a
  role may ever use, derived from its tool list.
- **Task allocation** (`sessions` tool `mcp` field, PR #24): per-task
  allowlist + budgets, tighten-only vs the role ceiling, enforced by deny
  rules + the budget gate at dispatch.

`acquire_mcp` accepts an optional `role`: when given, the server is checked
against that role's ceiling (`mcpServersOf`) **before** acquiring — outside
the ceiling the call is refused with the ceiling spelled out. Installing a
server never widens any role: tool advertisement still filters through
profiles and session permissions (`McpCatalog.Plugin` shows a session only
the servers its role can reach, and flags required-but-unavailable ones).
Removing an MCP from one role is a task/profile operation on that role's
allowlist — it never disconnects the shared server for other roles; nothing
in this branch calls `disconnect`/`remove` on a role's behalf.

## 7. Budgets

Unchanged enforcement (PR #35): every `callTool` with a session id passes
the budget gate — one immediate DB transaction, fail-closed, epoch-scoped
per task hand-out. Acquisition does not touch budgets; the Orchestrator
still chooses per-task totals (defaults: 24 calls, 12 for read-only roles,
0 for roles with no MCP servers) when it distributes work.

## 8. Verification (see FINAL_VERIFICATION.md)

`packages/core/test/mcp-acquire.test.ts` — 10 tests against a fake service
implementing the real `Access` slice: classification matrix (incl.
connected-but-no-tools = degraded, missing-credential detection),
deterministic selection, reuse without mutation, install+connect+verify,
connect of a starting server, **no install when credentials are missing**,
no re-enable of disabled, no retry of failed, honest `failed` after a bad
install.

## Addendum — review round (selection quality and honest failures)

- **Selection is no longer a bare keyword hit.** An entry qualifies only
  via a name/id hit, ≥2 distinct matched tokens, a weighted score ≥ 4, or a
  *discriminating* token (present in at most a quarter of the catalog) in
  the description or name. Ubiquitous words ("use" appears in 14 of 17
  entries) never qualify an entry alone. Tokenization is Unicode-aware.
- **Degraded is not "reused".** A connected server with no discovered
  tools gets one reconnect (restart + fresh discovery); if it is still
  toolless, the result reports `degraded` with the reconnect as the action.
- **Connect errors are preserved.** `ensure()` captures the connect
  attempt's failure and returns it as `connectError` (and inside the
  detail) whenever the server does not end up healthy — diagnosis no
  longer depends on re-reading service state after a swallowed error.
- **The role guard is a pure, unit-tested function** (`acquireCeiling`):
  acquisition for a role whose ceiling excludes the server is refused
  before any install. The ceiling is derived from the role's own tool
  list and is only read, never widened. Independent of acquisition, a
  globally connected server reaches a session only through the existing
  narrows: the catalog context lists servers whose tools survive the
  session's permission-narrowed snapshot, unlisted tool calls evaluate to
  `ask` (decided by the project orchestrator's permission delegate, never
  a silent allow), and a distributed task limit turns out-of-profile
  servers into hard denies under the budget gate.
