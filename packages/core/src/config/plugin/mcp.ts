export * as ConfigMcpPlugin from "./mcp.js"

import { define } from "@orchestra/plugin/effect/plugin"
import { Document, type Entry } from "@orchestra/schema/config"
import type { ServerConfig } from "@orchestra/schema/mcp"
import { Effect, Stream } from "effect"
import { Config } from "../../config.js"
import { McpLifecycle } from "../../mcp/lifecycle.js"
import { Mcp } from "../../mcp/index.js"

export const Plugin = define({
  id: "orchestra.config.mcp",
  effect: Effect.fn(function* (ctx) {
    yield* register(ctx.event.subscribe())
  }),
})

export const register = Effect.fn("ConfigMCPPlugin.register")(function* (
  events: Stream.Stream<{ readonly type: string }, unknown>,
) {
  const config = yield* Config.Service
  const mcp = yield* Mcp.Service
  const loaded = { entries: [] as Entry[] }

  yield* events.pipe(
    Stream.filter((event) => event.type === "config.updated"),
    Stream.runForEach(() =>
      config.entries().pipe(
        Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
        Effect.andThen(mcp.reload()),
        Effect.catchCause((cause) => Effect.logError("failed to reload MCP config", { cause })),
      ),
    ),
    Effect.ignore,
    Effect.forkScoped({ startImmediately: true }),
  )

  // One-time default-off migration, before the initial load feeds any server
  // to the runtime: on the first startup with AI-managed MCP, every enabled
  // server in the global config is persistently disabled so nothing connects
  // until the Orchestrator decides it is needed. Idempotent via its KV
  // marker; a failure is logged and never blocks startup (the next start
  // retries, and disabling twice is harmless).
  yield* McpLifecycle.live().pipe(
    Effect.flatMap((access) => McpLifecycle.migrateDefaultOff(access)),
    Effect.tap((result) =>
      result.disabled.length > 0
        ? Effect.logInfo("MCP default-off migration: persistently disabled servers", { servers: result.disabled })
        : Effect.void,
    ),
    Effect.catchCause((cause) => Effect.logError("MCP default-off migration failed; will retry on next start", { cause })),
  )

  // Subscribe before the initial load so updates racing it trigger a rebuild.
  loaded.entries = yield* config.entries()
  yield* mcp.transform((editor) => {
    const documents = loaded.entries.filter((entry): entry is Document => entry.type === "document")
    // Global timeout defaults merge in config order; each server can override them.
    const timeout = Object.assign(
      {},
      ...documents.flatMap((entry) => (entry.info.mcp?.timeout ? [entry.info.mcp.timeout] : [])),
    )
    const servers = new Map<string, ServerConfig>()
    for (const document of documents) {
      for (const [name, server] of Object.entries(document.info.mcp?.servers ?? {})) {
        servers.set(name, server)
      }
    }
    for (const [name, server] of servers) {
      if (editor.get(name)) continue
      editor.set(name, { ...server, timeout: { ...timeout, ...server.timeout } })
    }
  })
})
