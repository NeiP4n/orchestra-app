export * as McpPool from "./pool.js"

import path from "node:path"
import { Deferred, Effect, Exit, Scope } from "effect"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { Environment } from "../environment/index.js"
import { McpClient } from "./client.js"

type Listeners = {
  close: Set<(reason: string) => void>
  sessionExpired: Set<() => void>
  tools: Set<() => void>
  prompts: Set<() => void>
  resources: Set<() => void>
}

type Shared = {
  users: number
  readonly scope: Scope.Closeable
  readonly ready: Deferred.Deferred<McpClient.Connection, unknown>
  readonly listeners: Listeners
}

// One pool per execution plane, so a workspace-backed location never shares a process with the host. An
// Environment is built per Location, so it cannot be the key: keying on it meant every Location had a pool of
// its own and nothing was ever shared. The plane is the workspace the Location runs in, or "local".
const pools = new Map<string, Map<string, Shared>>()

// Locations with different working directories keep separate processes, so several of them start the same
// `npx -y <package>` at once. npm installs into one shared cache directory per package, and concurrent
// installs corrupt it (ENOTEMPTY, missing files, ERR_MODULE_NOT_FOUND) until the directory is deleted by
// hand. Starting an identical launcher one at a time lets the first install and the rest reuse the cache.
const launches = KeyedMutex.makeUnsafe<string>()

/**
 * Connects an MCP server, sharing one stdio process between every Location that would spawn an
 * identical one: same Environment, command, arguments and declared environment. Remote servers are
 * connected per Location as before. A shared connection is closed when its last Location releases
 * it, or forgotten as soon as it drops so the next connect starts a fresh process.
 *
 * The working directory is part of the key only when the server config sets `cwd` itself (or
 * ORCHESTRA_MCP_PER_DIRECTORY is set). A Society or a team opens a Location per project folder, and
 * keying on the folder started a full copy of every server, each one a chain of three or four
 * processes, per folder: dozens of copies of the same memory or browser server and a machine out of
 * memory. Servers are tools, not project state, so one process serves them all.
 *
 * The first Location's elicitation handler and `roots/list` directory serve the shared connection.
 */
export const connect = Effect.fnUntraced(function* (
  server: string,
  config: Parameters<typeof McpClient.connect>[1],
  directory: string,
  authProvider?: Parameters<typeof McpClient.connect>[3],
  elicitation?: Parameters<typeof McpClient.connect>[4],
  clientInfo?: Parameters<typeof McpClient.connect>[5],
  plane = "local",
) {
  if (config.type !== "local")
    return yield* McpClient.connect(server, config, directory, authProvider, elicitation, clientInfo)

  const shares = pools.get(plane) ?? new Map<string, Shared>()
  pools.set(plane, shares)
  const key = JSON.stringify([
    server,
    config.command,
    config.environment ?? {},
    config.cwd ? path.resolve(directory, config.cwd) : process.env.ORCHESTRA_MCP_PER_DIRECTORY ? directory : "",
  ])

  const existing = shares.get(key)
  const shared = existing ?? (yield* open(shares, key, server, config, directory, authProvider, elicitation, clientInfo))
  shared.users++

  const mine: Listeners = { close: new Set(), sessionExpired: new Set(), tools: new Set(), prompts: new Set(), resources: new Set() }
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const name of Object.keys(mine) as (keyof Listeners)[])
        for (const callback of mine[name] as Set<never>) (shared.listeners[name] as Set<never>).delete(callback)
      shared.users--
      if (shared.users > 0) return
      if (shares.get(key) === shared) shares.delete(key)
      yield* Scope.close(shared.scope, Exit.void)
    }),
  )

  const connection = yield* Deferred.await(shared.ready)
  const subscribe =
    <K extends keyof Listeners>(name: K) =>
    (callback: Parameters<Listeners[K]["add"]>[0]) => {
      ;(mine[name] as Set<unknown>).add(callback)
      ;(shared.listeners[name] as Set<unknown>).add(callback)
    }
  return {
    ...connection,
    onClose: subscribe("close"),
    onSessionExpired: subscribe("sessionExpired"),
    onToolsChanged: subscribe("tools"),
    onPromptsChanged: subscribe("prompts"),
    onResourcesChanged: subscribe("resources"),
  } satisfies McpClient.Connection
})

// The connection runs in a scope of its own, not the first Location's, so that Location closing does
// not take the process away from the others.
const open = Effect.fnUntraced(function* (
  plane: Map<string, Shared>,
  key: string,
  server: string,
  config: Extract<Parameters<typeof McpClient.connect>[1], { type: "local" }>,
  directory: string,
  authProvider: Parameters<typeof McpClient.connect>[3],
  elicitation: Parameters<typeof McpClient.connect>[4],
  clientInfo: Parameters<typeof McpClient.connect>[5],
) {
  const environment = yield* Environment.Service
  const scope = yield* Scope.make()
  const shared: Shared = {
    users: 0,
    scope,
    ready: yield* Deferred.make<McpClient.Connection, unknown>(),
    listeners: { close: new Set(), sessionExpired: new Set(), tools: new Set(), prompts: new Set(), resources: new Set() },
  }
  plane.set(key, shared)
  const forget = () => {
    if (plane.get(key) === shared) plane.delete(key)
  }

  yield* McpClient.connect(server, config, directory, authProvider, elicitation, clientInfo).pipe(
    Effect.provideService(Environment.Service, environment),
    Scope.provide(scope),
    launches.withLock(JSON.stringify(config.command)),
    Effect.exit,
    Effect.flatMap((exit) => {
      if (Exit.isFailure(exit)) {
        forget()
        return Deferred.done(shared.ready, exit)
      }
      const connection = exit.value
      const fan = (name: keyof Listeners) => (...args: unknown[]) =>
        shared.listeners[name].forEach((callback) => (callback as (...args: unknown[]) => void)(...args))
      connection.onClose((reason) => {
        forget()
        fan("close")(reason)
      })
      connection.onSessionExpired(fan("sessionExpired"))
      connection.onToolsChanged(fan("tools"))
      connection.onPromptsChanged(fan("prompts"))
      connection.onResourcesChanged(fan("resources"))
      return Deferred.succeed(shared.ready, connection)
    }),
    Effect.forkIn(scope),
  )
  return shared
})
