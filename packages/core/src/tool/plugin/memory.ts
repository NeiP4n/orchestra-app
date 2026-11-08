export * as MemoryTool from "./memory.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import { ToolFailure } from "@orchestra/ai"
import { optional } from "@orchestra/schema/schema"
import type { Tool } from "@orchestra/schema/tool"
import { Effect, Schema } from "effect"
import { Memory } from "../../memory/index.js"
import { getMemoryEngineForProject } from "../../memory/engine.js"
import { bunRuntime } from "../../runtime.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"

export const name = "memory"

export const Input = Schema.Struct({
  action: Schema.Literals([
    "search",
    "remember",
    "link",
    "recall",
    "stats",
    "read",
    "write",
    "list",
    "view",
    "append",
    "replace",
    "rewrite",
    "delete",
    "forget",
  ]).annotate({
    description:
      "Native associative memory actions: search, remember, link, recall, stats, read, write, list, view, append, replace, rewrite, delete, forget",
  }),
  label: optional(
    Schema.String.annotate({ description: "Block label: 2 to 40 lowercase latin letters, digits and hyphens" }),
  ),
  scope: optional(
    Memory.Scope.annotate({
      description: "user follows the person across projects, project stays with this repository",
    }),
  ),
  text: optional(Schema.String.annotate({ description: "Text to append to a block or to remember" })),
  old: optional(Schema.String.annotate({ description: "replace: exact text currently in the block" })),
  new: optional(Schema.String.annotate({ description: "replace: text that takes its place, empty to delete it" })),
  value: optional(Schema.String.annotate({ description: "write/rewrite: the whole new value of the block" })),
  description: optional(Schema.String.annotate({ description: "rewrite: what belongs in the block" })),
  limit: optional(Schema.Number.annotate({ description: "limit of results or characters" })),
  tags: optional(Schema.Array(Schema.String).annotate({ description: "remember: short lowercase tags" })),
  query: optional(Schema.String.annotate({ description: "search/recall: words or concepts to look for, any language" })),
  sessions: optional(
    Schema.Boolean.annotate({ description: "search: also search earlier chats of this project, true by default" }),
  ),
  id: optional(Schema.String.annotate({ description: "forget: id of a fact to forget" })),
  entity: optional(Schema.String.annotate({ description: "remember: entity name (e.g. 'user', 'project', 'architecture')" })),
  kind: optional(Schema.String.annotate({ description: "remember: entity kind (e.g. 'person', 'concept', 'preference', 'rule')" })),
  source: optional(Schema.String.annotate({ description: "link: source entity name or id" })),
  target: optional(Schema.String.annotate({ description: "link: target entity name or id" })),
  type: optional(Schema.String.annotate({ description: "link: relation type (e.g. 'prefers', 'depends_on', 'uses')" })),
  weight: optional(Schema.Number.annotate({ description: "link: relation weight (default 1.0)" })),
})
export type Input = typeof Input.Type

export const description = [
  "Native associative-vector long-term memory engine and blocks.",
  "",
  "Native Memory Engine (fast associative-vector retrieval in SQLite):",
  "  remember — save an observation/fact into associative-vector memory: text, optional entity, kind, scope.",
  "  link — connect two entities in the knowledge graph: source, target, type, optional weight.",
  "  search — hybrid search (BM25 + cosine + trigram) across memories: query, optional scope, limit.",
  "  recall — extract compact semantic context ready for agent prompts: query, optional limit.",
  "  stats — display graph and memory engine statistics.",
  "",
  "Blocks & Archive (backward compatibility):",
  "  read / view — show blocks or read a specific block by label.",
  "  write / rewrite — create or rewrite a memory block.",
  "  list — list all memory blocks.",
  "  append / replace / delete — modify block content.",
  "  forget — remove an observation/entity by id.",
].join("\n")

export const Plugin = {
  id: "orchestra.tool.memory",
  effect: Effect.fn("MemoryTool.Plugin")(function* (ctx: Context) {
    const memory = yield* Memory.Service
    const permission = yield* Permission.Service
    const location = yield* Location.Service

    // Memory writes are permanent and feed every later request, so they
    // are not free: read actions (search, recall, read, list, stats) run
    // without approval, but every write goes through permission.assert and
    // can be denied by the operator's permission rules.
    const writeActions: ReadonlyArray<Input["action"]> = [
      "remember",
      "link",
      "write",
      "rewrite",
      "append",
      "replace",
      "delete",
      "forget",
    ]

    const run = Effect.fn("MemoryTool.run")(function* (input: Input, context: Tool.Context) {
      const sessionID = context.sessionID

      if (writeActions.includes(input.action)) {
        const resource = `memory:${input.scope ?? "project"}:${input.label ?? input.id ?? "block"}`

        yield* permission
          .assert({
            action: name,
            resources: [resource],
            save: [resource],
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
          })
          .pipe(Effect.mapError((error) => new ToolFailure({ message: `Memory ${input.action} denied`, error })))
      }

      // B18 №38: the engine opens the database of THIS project
      // (`<project>/.orchestra/memory.db`), never the process working
      // directory — a session whose CWD moved must not move its memory.
      // A build without the Bun sqlite engine can never construct it: refuse
      // BEFORE any mkdir or write, instead of leaking a stack or returning
      // nothing. An operational open failure under Bun reports the real cause.
      if (!bunRuntime())
        return yield* new ToolFailure({
          message:
            "The memory tool needs the Bun-backed project memory database, which this build does not have. Use the Bun build for project memory.",
        })
      const engine = yield* Effect.try({
        try: () => getMemoryEngineForProject(location.project.directory),
        catch: (cause) =>
          new ToolFailure({
            message: `The project memory database could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`,
            error: cause,
          }),
      })

      switch (input.action) {
        case "remember": {
          const text = yield* need(input, "text")
          const engineRes = engine.remember({
            text,
            entity: input.entity
              ? {
                  name: input.entity,
                  kind: input.kind,
                }
              : undefined,
            scope: input.scope,
            source: sessionID,
          })

          // Зеркалируем в архив для совместимости
          yield* memory.remember({
            text,
            tags: input.tags,
            scope: input.scope,
          }).pipe(Effect.ignore)

          return `Remembered fact ${engineRes.observationID} for entity ${engineRes.entityID} (${input.scope ?? "project"}).`
        }

        case "link": {
          const source = yield* need(input, "source")
          const target = yield* need(input, "target")
          const type = yield* need(input, "type")
          const res = engine.link({
            source,
            target,
            type,
            weight: input.weight,
          })
          return `Linked ${res.sourceID} -[${type}]-> ${res.targetID} (relation: ${res.id}).`
        }

        case "recall": {
          const query = yield* need(input, "query")
          const context = engine.recall(query, {
            limit: input.limit ?? 5,
            scope: input.scope,
          })
          if (!context) {
            return "No relevant memory found for this context."
          }
          return context
        }

        case "stats": {
          const stats = engine.stats()
          return [
            "Native Memory Engine Statistics:",
            `- Entities: ${stats.entities}`,
            `- Observations: ${stats.observations}`,
            `- Relations: ${stats.relations}`,
            `- Documents: ${stats.docs}`,
            `- Indexed terms: ${stats.terms}`,
          ].join("\n")
        }

        case "search": {
          const query = yield* need(input, "query")
          const engineResults = engine.search(query, {
            limit: input.limit ?? 10,
            scope: input.scope,
          })

          const legacyFound = yield* memory.search({
            query,
            scope: input.scope,
            limit: input.limit,
            sessions: input.sessions,
            session: sessionID,
          }).pipe(Effect.orElseSucceed(() => ({ entries: [], recalled: [] })))

          const lines: string[] = []

          if (engineResults.length > 0) {
            lines.push("Associative Memory (Native SQLite Engine):")
            for (const item of engineResults) {
              const ent = item.entityName ? ` [${item.entityName}]` : ""
              lines.push(`- (${item.score}) ${item.id}${ent}: ${item.content}`)
            }
          }

          if (legacyFound.entries.length > 0) {
            lines.push("Archive:")
            for (const entry of legacyFound.entries) {
              lines.push(`- ${entry.id} (${entry.scope}): ${entry.text}`)
            }
          }

          if (legacyFound.recalled.length > 0) {
            lines.push("Earlier chats:")
            for (const item of legacyFound.recalled) {
              lines.push(`- ${item.sessionID} "${item.title}": ${item.text}`)
            }
          }

          if (lines.length === 0) {
            return "Nothing found in memory."
          }

          return lines.join("\n")
        }

        case "read":
        case "view": {
          const blocks = yield* memory.blocks()
          if (input.label) {
            const found = blocks.find((b) => b.label === input.label && (!input.scope || b.scope === input.scope))
            if (!found) return `Block ${input.label} not found.`
            return show(found)
          }
          return blocks.map(show).join("\n\n")
        }

        case "list": {
          const blocks = yield* memory.blocks()
          return blocks
            .map((b) => `- ${b.label} (${b.scope}): ${b.value.length}/${b.limit} chars`)
            .join("\n")
        }

        case "write":
        case "rewrite": {
          return changed(
            "Rewrote",
            yield* memory.rewrite({
              label: yield* need(input, "label"),
              value: input.value ?? input.text ?? "",
              description: input.description,
              limit: input.limit,
              scope: input.scope,
            }),
          )
        }

        case "append": {
          return changed(
            "Appended to",
            yield* memory.append({
              label: yield* need(input, "label"),
              text: yield* need(input, "text"),
              scope: input.scope,
            }),
          )
        }

        case "replace": {
          return changed(
            "Updated",
            yield* memory.replace({
              label: yield* need(input, "label"),
              old: yield* need(input, "old"),
              new: input.new ?? "",
              scope: input.scope,
            }),
          )
        }

        case "delete": {
          const block = yield* memory.drop({ label: yield* need(input, "label"), scope: input.scope })
          return `Deleted block ${block.label} (${block.scope}).`
        }

        case "forget": {
          const id = yield* need(input, "id")
          engine.forget({ id })
          yield* memory.forget({ id }).pipe(Effect.option)
          return `Forgot memory item ${id}.`
        }
      }
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, triggers: ["запомни|не забудь|remember"] },
          description,
          input: Input,
          execute: (input, context) =>
            run(input, context).pipe(
              Effect.map((output) => ({ content: output })),
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: error.message }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

const need = <K extends "label" | "text" | "old" | "query" | "id" | "source" | "target" | "type">(
  input: Input,
  key: K,
) => {
  const value = input[key]
  return value === undefined || value === ""
    ? Effect.fail(new ToolFailure({ message: `memory ${input.action} needs ${key}` }))
    : Effect.succeed(value)
}

function show(block: Memory.Block) {
  return [
    `${block.label} (${block.scope}, ${block.value.length}/${block.limit} chars)${block.description ? ` — ${block.description}` : ""}`,
    block.value || "(empty)",
  ].join("\n")
}

function changed(verb: string, block: Memory.Block) {
  return `${verb} block ${block.label} (${block.scope}), now ${block.value.length}/${block.limit} chars:\n${block.value}`
}
