export * as McpManagerTool from "./mcp-manager.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { McpAcquire } from "../../mcp/acquire.js"
import { McpCatalog } from "../../mcp/catalog.js"
import { McpLifecycle } from "../../mcp/lifecycle.js"
import { Orchestra } from "../../orchestra.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { acquireCeiling, MCP_SURVEY_METADATA_KEY } from "./orchestra.js"

export const name = "mcp_manager"

const description = [
  "Manage the MCP fleet lifecycle as the Orchestrator. The fleet is AI-managed: servers stay persistently disabled until a task needs them.",
  "Actions: inspect lists every configured server with its origin (orchestra = untouched catalog install, user = user-managed), status, discovered tools, leases and pins. enable persistently enables a server and verifies it actually works (connected AND tools discovered). disable persistently disables it (config preserved, survives restart) — refused while another task leases it or the operator pinned it. remove deletes a server's config entry after archiving it (restore brings it back); Orchestra-managed servers can be removed autonomously, user-managed ones only with approved: true after the operator agreed. acquire selects and installs a catalog server for a capability need (need) or a server id, then enables it. lease/release stake or free a task's claim on a server so other work cannot disable it mid-task. pin/unpin mark an operator keep-on decision.",
  "Pass role when acting for a specific role: servers outside that role's MCP ceiling are refused — enabling globally never grants a role access. Pass holder (a session or task id) on lease/release, and on disable to release your own lease first.",
  "Never enable the whole catalog: enable only what the current task needs, and disable what no active task needs anymore.",
].join("\n")

export const Input = Schema.Struct({
  action: Schema.Literals([
    "inspect",
    "enable",
    "disable",
    "remove",
    "restore",
    "acquire",
    "lease",
    "release",
    "pin",
    "unpin",
  ]),
  server: Schema.optionalKey(Schema.String).annotate({ description: "Server id the action applies to" }),
  need: Schema.optionalKey(Schema.String).annotate({
    description: "For acquire: the capability needed, in words (e.g. 'browser automation'), when no exact server id is known",
  }),
  role: Schema.optionalKey(Schema.String).annotate({
    description: "Role the server is being prepared for; its MCP ceiling is enforced",
  }),
  holder: Schema.optionalKey(Schema.String).annotate({
    description: "Lease holder: the session, task or stage id that depends on the server",
  }),
  note: Schema.optionalKey(Schema.String).annotate({ description: "Why the lease is needed (recorded with it)" }),
  approved: Schema.optionalKey(Schema.Boolean).annotate({
    description: "For remove: the operator explicitly approved deleting this user-managed server's configuration",
  }),
})

export const Output = Schema.Struct({ output: Schema.String })

export const Plugin = {
  id: "orchestra.tool.mcp-manager",
  effect: Effect.fn("McpManagerTool.Plugin")(function* (ctx: Context) {
    const orchestra = yield* Orchestra.Service
    const sessions = yield* Session.Service
    const access = yield* McpLifecycle.live().pipe(Effect.option)

    // Like the sessions tool, the manager only exists for a project's main
    // session: worker sessions never see it, so they cannot be prompted
    // into reconfiguring the fleet.
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        if (!event.tools[name]) return
        if (!(yield* orchestra.mainOf(event.sessionID))) delete event.tools[name]
      }),
    )

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name,
        options: { codemode: false, core: true },
        description,
        input: Input,
        output: Output,
        execute: (input, context) => run(input, context).pipe(Effect.map((result) => ({ output: result, content: result.output }))),
      }),
    )

    const run = (input: typeof Input.Type, context: { sessionID: SessionSchema.ID }) =>
      Effect.gen(function* () {
            if (Option.isNone(access))
              return yield* new ToolFailure({
                message: "The MCP lifecycle manager is not available in this runtime (config, MCP or storage service missing).",
              })
            const lifecycle = access.value
            const fail = (message: string) => new ToolFailure({ message })
            // Lifecycle operations fail with plain Errors (config write and
            // storage failures); the leaf translates them to ToolFailure.
            const guard = <A>(effect: Effect.Effect<A, Error>) =>
              effect.pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))

            const requireServer = () => {
              const server = input.server?.trim()
              if (!server) return undefined
              return server
            }

            const checkRole = (server: string) =>
              Effect.gen(function* () {
                if (!input.role) return undefined
                const role = (yield* orchestra.roles()).find((item) => item.id === input.role || item.name === input.role)
                if (!role) return `Unknown role "${input.role}".`
                return acquireCeiling(role, server)
              })

            switch (input.action) {
              case "inspect": {
                const rows = yield* guard(McpLifecycle.inspect(lifecycle))
                const active = rows.filter((row) => row.status === "connected").length
                const lines = rows.map((row) => {
                  const parts = [
                    `- ${row.name}: ${row.status}`,
                    row.origin ? `origin ${row.origin}` : undefined,
                    row.definedIn ? `defined in ${row.definedIn} config` : undefined,
                    row.disabled ? "persistently disabled" : undefined,
                    row.tools.length > 0 ? `tools: ${row.tools.join(", ")}` : undefined,
                    row.leases.length > 0
                      ? `leased by ${row.leases.map((lease) => lease.holder).join(", ")}`
                      : undefined,
                    row.pinned ? "pinned by operator" : undefined,
                    row.archived ? "an archived copy exists" : undefined,
                  ].filter((part) => part !== undefined)
                  return parts.join(" · ")
                })
                // The survey covers both halves of the fleet: what is configured
                // (above) and what could still be installed from the catalog.
                const configured = new Set(rows.map((row) => row.name))
                const installable = McpCatalog.all.filter(
                  (entry) => !configured.has(entry.id) && !configured.has(entry.name),
                )
                // Running inspect is the session's MCP survey: the sessions tool
                // refuses a first dispatch until this stamp exists, so an MCP
                // assignment is always made after seeing the fleet, never by
                // default. Best-effort: a stamp failure must not fail the survey.
                yield* sessions
                  .get(context.sessionID)
                  .pipe(
                    Effect.flatMap((self) =>
                      sessions.setMetadata({
                        sessionID: context.sessionID,
                        metadata: {
                          ...(self.metadata ?? {}),
                          [MCP_SURVEY_METADATA_KEY]: {
                            at: Date.now(),
                            configured: rows.length,
                            catalog: McpCatalog.all.length,
                          },
                        },
                      }),
                    ),
                    Effect.ignore,
                  )
                return {
                  output: [
                    rows.length === 0
                      ? "No MCP servers are configured."
                      : `MCP fleet: ${active} active · ${rows.length - active} inactive of ${rows.length} configured.`,
                    ...lines,
                    ...(installable.length > 0
                      ? [
                          `Installable from the catalog (${installable.length}, not configured):`,
                          ...installable.map((entry) => `- ${entry.id}: ${entry.description}`),
                        ]
                      : []),
                  ].join("\n"),
                }
              }
              case "enable": {
                const server = requireServer()
                if (!server) return yield* fail("Action enable needs a server id.")
                const refusal = yield* checkRole(server)
                if (refusal) return yield* fail(refusal)
                const outcome = yield* guard(McpLifecycle.enable(lifecycle, server))
                if (input.holder) yield* guard(McpLifecycle.acquireLease(lifecycle, server, input.holder, input.note))
                return {
                  output: `${server}: ${outcome.state} — ${outcome.detail}${outcome.tools.length > 0 ? ` Tools: ${outcome.tools.join(", ")}.` : ""}`,
                }
              }
              case "disable": {
                const server = requireServer()
                if (!server) return yield* fail("Action disable needs a server id.")
                const outcome = yield* guard(McpLifecycle.disable(lifecycle, server, input.holder))
                if (!outcome.ok) return yield* fail(outcome.detail)
                return { output: outcome.detail }
              }
              case "remove": {
                const server = requireServer()
                if (!server) return yield* fail("Action remove needs a server id.")
                const outcome = yield* guard(McpLifecycle.removeServer(lifecycle, server, input.approved === true))
                if (!outcome.ok) return yield* fail(outcome.detail)
                return { output: outcome.detail }
              }
              case "restore": {
                const server = requireServer()
                if (!server) return yield* fail("Action restore needs a server id.")
                const outcome = yield* guard(McpLifecycle.restore(lifecycle, server))
                if (!outcome.ok) return yield* fail(outcome.detail)
                return { output: outcome.detail }
              }
              case "acquire": {
                const picked = input.server?.trim()
                  ? [{ entry: { id: input.server.trim() }, score: 0, reasons: [] as string[] }]
                  : input.need
                    ? McpAcquire.select(input.need)
                    : undefined
                if (!picked) return yield* fail("Action acquire needs a server id or a need in words.")
                if (picked.length === 0)
                  return yield* fail(`No catalog server matches "${input.need}". Inspect the fleet or describe the need differently.`)
                const id = picked[0]!.entry.id
                const refusal = yield* checkRole(id)
                if (refusal) return yield* fail(refusal)
                const ensured = yield* McpAcquire.ensure(McpLifecycle.acquireAccess(lifecycle), id)
                if (ensured.state === "needs_auth")
                  return {
                    output: `${id}: needs authorization before it can be installed — ${ensured.detail} Nothing was installed.`,
                  }
                if (ensured.state !== "healthy" && ensured.state !== "degraded")
                  return { output: `${id}: ${ensured.state} (${ensured.action}) — ${ensured.detail}` }
                // A catalog install lands enabled in the runtime; make the
                // enabled state the persistent one too, then verify.
                const outcome = yield* guard(McpLifecycle.enable(lifecycle, id))
                if (input.holder) yield* guard(McpLifecycle.acquireLease(lifecycle, id, input.holder, input.note))
                return {
                  output: `${id}: acquired (${ensured.action}) and ${outcome.state} — ${outcome.detail}${outcome.tools.length > 0 ? ` Tools: ${outcome.tools.join(", ")}.` : ""}`,
                }
              }
              case "lease": {
                const server = requireServer()
                if (!server || !input.holder) return yield* fail("Action lease needs a server id and a holder.")
                const leases = yield* guard(McpLifecycle.acquireLease(lifecycle, server, input.holder, input.note))
                return {
                  output: `${server} leased by ${leases.map((lease) => lease.holder).join(", ")}. It cannot be disabled or removed while a lease stands.`,
                }
              }
              case "release": {
                const server = requireServer()
                if (!server || !input.holder) return yield* fail("Action release needs a server id and a holder.")
                const leases = yield* guard(McpLifecycle.releaseLease(lifecycle, server, input.holder))
                return {
                  output:
                    leases.length > 0
                      ? `${server} still leased by ${leases.map((lease) => lease.holder).join(", ")}.`
                      : `${server} has no leases left; it can be disabled or removed.`,
                }
              }
              case "pin": {
                const server = requireServer()
                if (!server) return yield* fail("Action pin needs a server id.")
                yield* guard(McpLifecycle.setPin(lifecycle, server, true))
                return { output: `${server} pinned: it stays on and cannot be disabled until unpinned.` }
              }
              case "unpin": {
                const server = requireServer()
                if (!server) return yield* fail("Action unpin needs a server id.")
                yield* guard(McpLifecycle.setPin(lifecycle, server, false))
                return { output: `${server} unpinned.` }
              }
            }
      })
  }),
}
