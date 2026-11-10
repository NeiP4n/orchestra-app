export * as McpManagerTool from "./mcp-manager.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { CapabilityInspect } from "../../capabilities/inspect.js"
import { CapabilityRegistry } from "../../capabilities/registry.js"
import { Tool as ToolService } from "../../tool.js"
import { Skill } from "../../skill.js"
import { Config } from "../../config.js"
import { operatorEnableRequest } from "../../mcp/disabled.js"
import { McpAcquire } from "../../mcp/acquire.js"
import { McpCatalog } from "../../mcp/catalog.js"
import { McpLifecycle } from "../../mcp/lifecycle.js"
import { McpRatings } from "../../mcp/ratings.js"
import { McpSelect } from "../../mcp/select.js"
import { Orchestra } from "../../orchestra.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { acquireCeiling, MCP_SURVEY_METADATA_KEY } from "./orchestra.js"

export const name = "mcp_manager"

const description = [
  "Manage the MCP fleet lifecycle as the Orchestrator. Operator-disabled servers remain OFF until the operator enables them in the Registry.",
  "Actions: inspect lists every configured server with its origin (orchestra = untouched catalog install, user = user-managed), status, discovered tools, leases and pins. enable returns an operator approval request without configuration changes or connection attempts. disable persistently disables it (config preserved, survives restart) — refused while another task leases it or the operator pinned it. remove deletes a server's config entry after archiving it (restore brings it back); Orchestra-managed servers can be removed autonomously, user-managed ones only with approved: true after the operator agreed. acquire selects and installs a catalog server for a capability need (need) or a server id, excluding operator-disabled servers — selection is ranked by the need with a fallback chain (context7 → deepwiki, serena → native symbols/grep, playwright → agent-desktop), and when no server fits confidently it answers with an ask-card (candidates + recommendation) instead of guessing. lease/release stake or free a task's claim on a server so other work cannot disable it mid-task. pin/unpin mark an operator keep-on decision.",
  "Pass role when acting for a specific role: servers outside that role's MCP ceiling are refused — enabling globally never grants a role access. Pass holder (a session or task id) on lease/release, and on disable to release your own lease first.",
  "Never re-enable an operator-disabled server. Request operator approval in the Registry. Disable only what no active task needs anymore.",
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

            // Persistent server ratings, best-effort: a missing rating store
            // is no evidence either way, never a reason to fail the action.
            const readRatings = () =>
              Effect.forEach(
                McpCatalog.all,
                (entry) =>
                  lifecycle.kvGet(McpRatings.ratingKey(entry.id)).pipe(
                    Effect.map((value) => ({ id: entry.id, rating: McpRatings.parseRating(value) })),
                    Effect.orElseSucceed(() => ({ id: entry.id, rating: undefined as McpRatings.Rating | undefined })),
                  ),
                { concurrency: "unbounded" },
              ).pipe(
                Effect.map((rows) => {
                  const ratings = new Map<string, McpRatings.Rating>()
                  for (const row of rows) if (row.rating) ratings.set(row.id, row.rating)
                  return ratings
                }),
                Effect.orElseSucceed(() => new Map<string, McpRatings.Rating>()),
              )

            switch (input.action) {
              case "inspect": {
                const rows = yield* guard(McpLifecycle.inspect(lifecycle))
                const tools = yield* Effect.serviceOption(ToolService.Service)
                const skills = yield* Effect.serviceOption(Skill.Service)
                const config = yield* Effect.serviceOption(Config.Service)
                const registered = Option.isSome(tools) ? yield* tools.value.list() : []
                const indexedSkills = Option.isSome(skills) ? yield* skills.value.list() : []
                const documents = Option.isSome(config) ? yield* config.value.entries() : []
                const plugins = documents.flatMap((row) => row.type === "document" ? row.info.plugins ?? [] : [])
                  .map((row) => typeof row === "string" ? row : row.package)
                  .filter((id): id is string => typeof id === "string")
                  .map((value, index) => {
                    const id = value.startsWith("-") ? value.slice(1) : value
                    // Local specifiers or URLs can contain paths/credentials; never put them in the compact index.
                    return { id: /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-z0-9._-]+)?$/i.test(id)
                      ? id : `configured-plugin-${index + 1}`, disabled: value.startsWith("-") }
                  })
                const capabilities = CapabilityInspect.inspect({ at: Date.now(), mcpEnabled: McpCatalog.mcpEnabled(process.env),
                  mcp: rows.map((row) => ({ name: row.name, disabled: row.disabled, status: row.status, tools: row.tools })),
                  native: CapabilityInspect.localToolIDs(registered, [...rows.map((row) => row.name), ...McpCatalog.all.map((row) => row.id)]),
                  skills: indexedSkills.map((row) => String(row.id)), plugins,
                })
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
                // It also shows the capability classes no server is needed
                // for — native tools cover them — and the persistent server
                // ratings, so the assignment is judged on evidence, not on
                // a first impression from one session.
                const configured = new Set(rows.map((row) => row.name))
                const installable = McpCatalog.all.filter(
                  (entry) => !configured.has(entry.id) && !configured.has(entry.name),
                )
                const ratings = yield* readRatings()
                const rated = [...ratings]
                  .map(([id, rating]) => ({ id, rating }))
                  .filter((row) => row.rating.calls > 0)
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
                    ...CapabilityRegistry.summary(capabilities),
                    `No MCP server needed for these — native tools cover them:`,
                    ...McpCatalog.nativeAnalogues.map(
                      (analogue) => `- ${analogue.id}: ${analogue.description} (use ${analogue.nativeTools.join(", ")})`,
                    ),
                    ...(rated.length > 0
                      ? [
                          `Server ratings from past calls (persistent across sessions):`,
                          ...rated.map(
                            (row) =>
                              `- ${row.id}: ${row.rating.successes}/${row.rating.calls} succeeded (${Math.round(McpRatings.successRate(row.rating) * 100)}%), mean latency ${Math.round(McpRatings.avgLatencyMs(row.rating) ?? 0)}ms`,
                          ),
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
                return { output: operatorEnableRequest("MCP server", server) }
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
                const explicit = input.server?.trim()
                const need = input.need?.trim()
                if (!explicit && !need) return yield* fail("Action acquire needs a server id or a need in words.")
                // An explicit id is a decision already made; a need in words
                // is ranked, and a low-confidence or tied ranking answers
                // with an ask-card instead of guessing a server.
                let server: string
                let chain: readonly McpSelect.Fallback[]
                let explanation = ""
                const configured = yield* lifecycle.configured()
                const runtime = yield* lifecycle.servers()
                const disabled = new Set([
                  ...Object.entries(configured).filter(([, row]) => row.disabled === true).map(([id]) => id),
                  ...runtime.filter((row) => row.status.status === "disabled").map((row) => String(row.name)),
                ])
                if (explicit) {
                  server = explicit
                  chain = McpSelect.fallbackChain(explicit)
                } else {
                  const ratings = yield* readRatings()
                  const decision = McpSelect.selectForTask(need!, { ratings, disabled })
                  if (decision.kind === "native")
                    return { output: `${decision.explanation} No server was installed.` }
                  if (decision.kind === "ask")
                    return {
                      output: [
                        decision.explanation,
                        `Ask which server to acquire (or answer with an explicit server id):`,
                        `Card: ${decision.card.title}`,
                        decision.card.text,
                        `Options: ${decision.card.options.join(", ")}${decision.card.recommend ? `; recommended: ${decision.card.recommend}` : ""}`,
                        "Nothing was installed.",
                      ].join("\n"),
                    }
                  server = decision.server
                  chain = decision.chain
                  explanation = decision.explanation
                }
                // The winner first, then its fallback chain: a dead primary
                // hands over to the next link instead of being hammered, and
                // the report says which link served. A role refusal of the
                // primary fails the action; a refusal of a fallback just
                // skips that link.
                const attempts: readonly McpSelect.Fallback[] = [{ kind: "mcp", server }, ...chain]
                const tried: string[] = []
                for (const attempt of attempts) {
                  if (attempt.kind === "native")
                    return {
                      output: [
                        ...(tried.length > 0 ? [`${tried.join("; ")}; falling back to native tools.`] : []),
                        `Use native tools instead: ${attempt.tools.join(", ")}. No server was installed.`,
                      ].join(" "),
                    }
                  const configured = yield* lifecycle.configured()
                  if (disabled.has(attempt.server) || configured[attempt.server]?.disabled === true) {
                    tried.push(`${attempt.server} (disabled by operator)`)
                    continue
                  }
                  const refusal = yield* checkRole(attempt.server)
                  if (refusal) {
                    if (attempt.server === server) return yield* fail(refusal)
                    tried.push(`${attempt.server} (refused for this role)`)
                    continue
                  }
                  const ensured = yield* McpAcquire.ensure(McpLifecycle.acquireAccess(lifecycle), attempt.server)
                  if (ensured.state === "needs_auth")
                    return {
                      output: `${attempt.server}: needs authorization before it can be installed — ${ensured.detail} Nothing was installed.`,
                    }
                  if (ensured.state === "healthy" || ensured.state === "degraded") {
                    if (input.holder)
                      yield* guard(McpLifecycle.acquireLease(lifecycle, attempt.server, input.holder, input.note))
                    return {
                      output: [
                        ...(explanation ? [explanation] : []),
                        ...(tried.length > 0 ? [`${tried.join("; ")}; fell back to ${attempt.server}.`] : []),
                        `${attempt.server}: acquired (${ensured.action}) and ${ensured.state} - ${ensured.detail}${ensured.tools.length > 0 ? ` Tools: ${ensured.tools.join(", ")}.` : ""}`,
                      ].join(" "),
                    }
                  }
                  tried.push(`${attempt.server} (${ensured.state}: ${ensured.detail})`)
                }
                return {
                  output: `No server could be acquired for "${need ?? explicit}": ${tried.join("; ")}. Nothing was installed.`,
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
