export * as McpLifecycle from "./lifecycle.js"

import type { ServerConfig } from "@orchestra/schema/mcp"
import { Cause, Effect, Schema } from "effect"
import path from "node:path"
import { Path } from "@orchestra/util/global"
import { Config } from "../config.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { KV } from "../kv.js"
import { McpAcquire } from "./acquire.js"
import { McpCatalog } from "./catalog.js"
import { Mcp } from "./index.js"

/**
 * Autonomous MCP lifecycle management: the layer that turns the MCP fleet
 * from "everything configured is connected" into an AI-managed environment.
 *
 * Three different operations are kept distinct, because the runtime alone
 * cannot provide the persistent ones:
 *
 * - disconnect() is a RUNTIME stop. The server comes back on restart.
 * - disable here is PERSISTENT: the server's config entry is rewritten with
 *   `disabled: true` through the official Config.update API, so it stays
 *   off across restarts until something enables it again.
 * - remove deletes the config entry — but only after the full configuration
 *   has been archived to KV, so every removal has a recovery path
 *   (restore), and credentials are never touched: they live in the
 *   credential store, keyed by name + URL, and survive removal by design.
 *
 * Ownership decides what the AI may do alone: a server whose id is in the
 * catalog AND whose effective config still equals the catalog entry is
 * Orchestra-managed (installed automatically, removable autonomously).
 * Anything else is user-managed: the AI may disable it, but permanent
 * removal needs explicit operator approval.
 */

export type Origin = "orchestra" | "user"

export function originOf(name: string, config: ServerConfig): Origin {
  const entry = McpCatalog.all.find((item) => item.id === name)
  if (!entry) return "user"
  const installed = entry.config
  if (installed.type !== config.type) return "user"
  if (installed.type === "local" && config.type === "local") {
    if (JSON.stringify(installed.command) !== JSON.stringify(config.command)) return "user"
    const extraEnv = Object.keys(config.environment ?? {}).filter((key) => !(key in (installed.environment ?? {})))
    return extraEnv.length === 0 ? "orchestra" : "user"
  }
  if (installed.type !== "local" && config.type !== "local") {
    return installed.url === config.url && config.headers === undefined ? "orchestra" : "user"
  }
  return "user"
}

export interface Lease {
  readonly holder: string
  readonly at: number
  readonly note?: string
}

/** Leases older than this with no renewal are swept as abandoned. */
export const LEASE_TTL_MS = 24 * 60 * 60 * 1000

const MIGRATION_KEY = "mcp/migration/default-off/v1"
const leaseKey = (server: string) => `mcp/lease/${server}`
const pinKey = (server: string) => `mcp/pin/${server}`
const archiveKey = (server: string) => `mcp/archive/${server}`

const leaseLocks = KeyedMutex.makeUnsafe<string>()

export interface Access {
  /** Every configured server, merged per-server across config documents in priority order. */
  readonly configured: () => Effect.Effect<Readonly<Record<string, ServerConfig>>>
  /** Only the servers defined in the global config document — the file Config.update edits. */
  readonly globalConfigured: () => Effect.Effect<Readonly<Record<string, ServerConfig>>>
  /** Persistent config write; a null value deletes the entry. Fails when the runtime cannot write config. */
  readonly update: (patch: Readonly<Record<string, ServerConfig | null>>) => Effect.Effect<void, Error>
  readonly servers: () => Effect.Effect<readonly Mcp.ServerInfo[]>
  readonly tools: () => Effect.Effect<readonly Mcp.Tool[]>
  readonly add: (server: string, config: ServerConfig) => Effect.Effect<void>
  readonly connect: (server: string) => Effect.Effect<void, Error>
  readonly disconnect: (server: string) => Effect.Effect<void, Error>
  readonly removeRuntime: (server: string) => Effect.Effect<void, Error>
  readonly kvGet: (key: string) => Effect.Effect<Schema.Json | undefined>
  readonly kvSet: (key: string, value: Schema.Json) => Effect.Effect<void>
  readonly kvRemove: (key: string) => Effect.Effect<void>
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

/**
 * The McpAcquire view of this Access: acquisition's ensure() re-classifies
 * state after a connect attempt instead of trusting its result, so a connect
 * failure is safe to surface as a defect for it to observe and move past.
 */
export const acquireAccess = (access: Access): McpAcquire.Access => ({
  servers: access.servers,
  add: access.add,
  connect: (server) => access.connect(server).pipe(Effect.orDie),
  tools: access.tools,
})

/** Build the production Access from the live services. */
export const live = Effect.fn("McpLifecycle.live")(function* () {
  const config = yield* Config.Service
  const mcp = yield* Mcp.Service
  const kv = yield* KV.Service

  const documents = () =>
    config.entries().pipe(Effect.map((entries) => entries.filter((entry) => entry.type === "document")))
  const merged = (docs: ReadonlyArray<{ info: { mcp?: { servers?: Record<string, ServerConfig> } } }>) => {
    const map = new Map<string, ServerConfig>()
    for (const doc of docs) for (const [name, server] of Object.entries(doc.info.mcp?.servers ?? {})) map.set(name, server)
    return Object.fromEntries(map) as Readonly<Record<string, ServerConfig>>
  }

  const access: Access = {
    configured: () => documents().pipe(Effect.map(merged)),
    globalConfigured: () =>
      documents().pipe(
        Effect.map((docs) => merged(docs.filter((doc) => doc.path !== undefined && path.dirname(doc.path) === Path.config))),
      ),
    update: (patch) => {
      const update = config.update
      if (!update) return Effect.fail(new Error("This runtime cannot write the global config."))
      return update({ mcpServers: patch }).pipe(Effect.mapError(asError))
    },
    servers: () => mcp.servers(),
    tools: () => mcp.tools(),
    add: (server, config) => mcp.add(server, config),
    connect: (server) => mcp.connect(server).pipe(Effect.mapError(asError)),
    disconnect: (server) => mcp.disconnect(server).pipe(Effect.mapError(asError)),
    removeRuntime: (server) => mcp.remove(server).pipe(Effect.mapError(asError)),
    kvGet: (key) => kv.get(key),
    kvSet: (key, value) => kv.set(key, value),
    kvRemove: (key) => kv.remove(key),
  }
  return access
})

// ---------------------------------------------------------------------------
// One-time default-off migration
// ---------------------------------------------------------------------------

export interface MigrationResult {
  readonly alreadyApplied: boolean
  /** Servers this pass persistently disabled (empty when already applied). */
  readonly disabled: readonly string[]
}

/**
 * The one-time transition to AI-managed MCP: every currently enabled server
 * in the GLOBAL config document is persistently disabled, configuration and
 * credentials untouched. The version marker is written only after the
 * config write succeeds, so an interrupted pass simply runs again — and
 * disabling an already-disabled server is a no-op, which makes the pass
 * idempotent. Servers defined only in project or compatibility sources are
 * deliberately out of scope: that configuration is not the global file's
 * to rewrite (see audit/MCP_DEFAULT_OFF_MIGRATION.md).
 */
export const migrateDefaultOff = Effect.fn("McpLifecycle.migrateDefaultOff")(function* (access: Access) {
  const marker = yield* access.kvGet(MIGRATION_KEY)
  if (marker !== undefined && typeof marker === "object" && marker !== null && "version" in marker && marker.version === 1)
    return { alreadyApplied: true, disabled: [] } satisfies MigrationResult

  const global = yield* access.globalConfigured()
  const enabled = Object.entries(global).filter(([, server]) => server.disabled !== true)
  if (enabled.length > 0) {
    const patch: Record<string, ServerConfig> = {}
    for (const [name, server] of enabled) patch[name] = { ...server, disabled: true }
    yield* access.update(patch)
  }
  const disabled = enabled.map(([name]) => name)
  yield* access.kvSet(MIGRATION_KEY, { version: 1, at: Date.now(), disabled })
  return { alreadyApplied: false, disabled } satisfies MigrationResult
})

// ---------------------------------------------------------------------------
// Leases and pins
// ---------------------------------------------------------------------------

function parseLeases(value: Schema.Json | undefined, now: number): Lease[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (item): item is { holder: string; at: number; note?: string } =>
        typeof item === "object" && item !== null && "holder" in item && "at" in item,
    )
    .filter((lease) => now - lease.at < LEASE_TTL_MS)
    .map((lease) => ({ holder: String(lease.holder), at: Number(lease.at), ...(lease.note ? { note: String(lease.note) } : {}) }))
}

export const activeLeases = Effect.fn("McpLifecycle.activeLeases")(function* (access: Access, server: string) {
  return parseLeases(yield* access.kvGet(leaseKey(server)), Date.now())
})

export const acquireLease = Effect.fn("McpLifecycle.acquireLease")(function* (
  access: Access,
  server: string,
  holder: string,
  note?: string,
) {
  return yield* leaseLocks.withLock(server)(
    Effect.gen(function* () {
      const now = Date.now()
      const leases = parseLeases(yield* access.kvGet(leaseKey(server)), now).filter((lease) => lease.holder !== holder)
      leases.push({ holder, at: now, ...(note ? { note } : {}) })
      yield* access.kvSet(leaseKey(server), JSON.parse(JSON.stringify(leases)) as Schema.Json)
      return leases
    }),
  )
})

export const releaseLease = Effect.fn("McpLifecycle.releaseLease")(function* (access: Access, server: string, holder: string) {
  return yield* leaseLocks.withLock(server)(
    Effect.gen(function* () {
      const leases = parseLeases(yield* access.kvGet(leaseKey(server)), Date.now()).filter(
        (lease) => lease.holder !== holder,
      )
      if (leases.length === 0) yield* access.kvRemove(leaseKey(server))
      if (leases.length > 0) yield* access.kvSet(leaseKey(server), JSON.parse(JSON.stringify(leases)) as Schema.Json)
      return leases
    }),
  )
})

export const isPinned = Effect.fn("McpLifecycle.isPinned")(function* (access: Access, server: string) {
  return (yield* access.kvGet(pinKey(server))) === true
})

export const setPin = Effect.fn("McpLifecycle.setPin")(function* (access: Access, server: string, pinned: boolean) {
  if (pinned) yield* access.kvSet(pinKey(server), true)
  if (!pinned) yield* access.kvRemove(pinKey(server))
})

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export interface ServerReport {
  readonly name: string
  readonly origin?: Origin
  /** Where the effective config is defined: the global file the manager can rewrite, or another source. */
  readonly definedIn?: "global" | "other"
  readonly disabled: boolean
  readonly status: string
  readonly tools: readonly string[]
  readonly leases: readonly Lease[]
  readonly pinned: boolean
  readonly archived: boolean
}

export const inspect = Effect.fn("McpLifecycle.inspect")(function* (access: Access) {
  const configured = yield* access.configured()
  const global = yield* access.globalConfigured()
  const servers = yield* access.servers()
  const tools = yield* access.tools()
  const names = new Set([...Object.keys(configured), ...servers.map((server) => String(server.name))])
  const reports: ServerReport[] = []
  for (const name of [...names].toSorted()) {
    const serverConfig = configured[name]
    const info = servers.find((server) => String(server.name) === name)
    reports.push({
      name,
      ...(serverConfig ? { origin: originOf(name, serverConfig) } : {}),
      ...(serverConfig ? { definedIn: name in global ? ("global" as const) : ("other" as const) } : {}),
      disabled: serverConfig?.disabled === true,
      status: info?.status.status ?? "not_running",
      tools: tools.filter((tool) => String(tool.server) === name).map((tool) => tool.name),
      leases: yield* activeLeases(access, name),
      pinned: yield* isPinned(access, name),
      archived: (yield* access.kvGet(archiveKey(name))) !== undefined,
    })
  }
  return reports
})

// ---------------------------------------------------------------------------
// Lifecycle operations — structured outcomes, policy refusals are data
// ---------------------------------------------------------------------------

export interface EnableOutcome {
  readonly ok: boolean
  readonly state: McpAcquire.State
  readonly detail: string
  readonly tools: readonly string[]
  readonly connectError?: string
}

export const enable = Effect.fn("McpLifecycle.enable")(function* (access: Access, name: string) {
  const configured = yield* access.configured()
  const serverConfig = configured[name]
  if (!serverConfig)
    return {
      ok: false,
      state: "unavailable" as const,
      detail: `${name} is not configured. Acquire it from the catalog first.`,
      tools: [],
    } satisfies EnableOutcome
  if (serverConfig.disabled === true) yield* access.update({ [name]: { ...serverConfig, disabled: false } })

  let connectError: string | undefined
  yield* access.connect(name).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        connectError = asError(Cause.squash(cause)).message
      }),
    ),
  )
  const info = (yield* access.servers()).find((server) => String(server.name) === name)
  const tools = yield* access.tools()
  const classified = McpAcquire.classify(name, info, tools)
  return {
    ok: classified.state === "healthy",
    state: classified.state,
    detail: connectError ? `${classified.detail} The connect attempt itself reported: ${connectError}` : classified.detail,
    tools: classified.tools,
    ...(connectError && classified.state !== "healthy" ? { connectError } : {}),
  } satisfies EnableOutcome
})

export interface DisableOutcome {
  readonly ok: boolean
  readonly detail: string
  readonly blockedBy?: readonly Lease[]
  readonly pinned?: boolean
}

export const disable = Effect.fn("McpLifecycle.disable")(function* (
  access: Access,
  name: string,
  exceptHolder?: string,
) {
  const blockers = (yield* activeLeases(access, name)).filter((lease) => lease.holder !== exceptHolder)
  if (blockers.length > 0)
    return {
      ok: false,
      detail: `${name} is leased by ${blockers.map((lease) => lease.holder).join(", ")}; a server in use by an active task is never disabled under it. Release the lease first if that task is done.`,
      blockedBy: blockers,
    } satisfies DisableOutcome
  if (yield* isPinned(access, name))
    return {
      ok: false,
      detail: `${name} is pinned by the operator and stays on. Unpin it before disabling.`,
      pinned: true,
    } satisfies DisableOutcome

  const configured = yield* access.configured()
  const serverConfig = configured[name]
  if (serverConfig && serverConfig.disabled !== true) yield* access.update({ [name]: { ...serverConfig, disabled: true } })
  // Runtime stop is best-effort on top of the persistent flag: a server with
  // no runtime entry is already stopped, and the config flag is the part
  // that must hold. A genuine runtime error still surfaces via the reload.
  yield* access.disconnect(name).pipe(Effect.ignore)
  return {
    ok: true,
    detail:
      serverConfig === undefined
        ? `${name} stopped for this session; it has no config entry, so nothing persists to disable.`
        : `${name} persistently disabled (config preserved); it will not reconnect on restart.`,
  } satisfies DisableOutcome
})

export interface RemoveOutcome {
  readonly ok: boolean
  readonly detail: string
  readonly needsApproval?: boolean
  readonly archived?: boolean
}

export const removeServer = Effect.fn("McpLifecycle.removeServer")(function* (
  access: Access,
  name: string,
  approved: boolean,
) {
  const configured = yield* access.configured()
  const serverConfig = configured[name]
  if (!serverConfig) return { ok: false, detail: `${name} is not configured.` } satisfies RemoveOutcome
  const origin = originOf(name, serverConfig)
  if (origin === "user" && !approved)
    return {
      ok: false,
      needsApproval: true,
      detail: `${name} is user-managed (not an untouched catalog install), so it is never deleted autonomously. The operator can approve removal explicitly; disabling it is always allowed.`,
    } satisfies RemoveOutcome
  const global = yield* access.globalConfigured()
  if (!(name in global))
    return {
      ok: false,
      detail: `${name} is defined outside the global config (project or compatibility source); the manager cannot delete another file's entry. Disable it, or remove it from its own config.`,
    } satisfies RemoveOutcome
  const blockers = yield* activeLeases(access, name)
  if (blockers.length > 0)
    return {
      ok: false,
      detail: `${name} is leased by ${blockers.map((lease) => lease.holder).join(", ")}; removal waits until no active task depends on it.`,
    } satisfies RemoveOutcome

  // Archive first: removal is reversible via restore, and the archive holds
  // only the config entry — credentials live in the credential store and
  // are intentionally not part of it.
  yield* access.kvSet(
    archiveKey(name),
    JSON.parse(JSON.stringify({ config: serverConfig, removedAt: Date.now(), origin })) as Schema.Json,
  )
  yield* access.update({ [name]: null })
  yield* access.removeRuntime(name).pipe(Effect.ignore)
  return {
    ok: true,
    archived: true,
    detail: `${name} removed from the global config; its configuration is archived and can be restored. Credentials were not touched.`,
  } satisfies RemoveOutcome
})

export const restore = Effect.fn("McpLifecycle.restore")(function* (access: Access, name: string) {
  const archived = yield* access.kvGet(archiveKey(name))
  if (archived === undefined || typeof archived !== "object" || archived === null || !("config" in archived))
    return { ok: false, detail: `No archived configuration for ${name}.` }
  const archivedConfig = (archived as { config: unknown }).config
  yield* access.update({ [name]: archivedConfig as ServerConfig })
  yield* access.kvRemove(archiveKey(name))
  return { ok: true, detail: `${name} restored from the archive into the global config (still disabled state as archived).` }
})
