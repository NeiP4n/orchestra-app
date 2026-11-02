export * as CodegraphTool from "./codegraph.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import { ToolFailure } from "@orchestra/ai"
import { optional } from "@orchestra/schema/schema"
import { Effect, Schema } from "effect"
import { indexProject } from "../../codegraph/indexer.js"
import { ensureIndexed, explore, impact, search as find, status } from "../../codegraph/query.js"
import { renderExplore, renderImpact, renderIndex, renderSearch, renderStatus } from "../../codegraph/render.js"
import { Location } from "../../location.js"

export const name = "codegraph"

export const Input = Schema.Struct({
  action: Schema.Literals(["search", "explore", "impact", "status", "index"]),
  /** Symbol name for search, explore and impact. */
  name: optional(Schema.String),
  /** Maximum hits for search. */
  limit: optional(Schema.Number),
  /** How many caller rings impact walks. */
  depth: optional(Schema.Number),
  /** Re-extract every file instead of only the changed ones. */
  force: optional(Schema.Boolean),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  output: Schema.String,
})
export type Output = typeof Output.Type

export const description = [
  "Navigate the project's code graph: declarations, who calls them and what a change would touch. Read-only apart from its own cache.",
  "TOOL CHOICE: use codegraph ONLY for callers and blast radius (explore/impact). For a simple text search use grep, for a file outline use symbols overview (or read if symbols fails). Do NOT use codegraph as a first search tool, and do NOT repeat a grep result with codegraph afterwards.",
  "",
  "Actions:",
  "  search — declarations whose name matches, best match first, with kind and location.",
  "  explore — one call for a symbol: where it is declared, who calls it and what it calls.",
  "  impact — callers at increasing depth, the blast radius of changing the symbol, plus the files to re-check.",
  "  status — what the index holds and when it was built.",
  "  index — rebuild the index; only files whose content changed are re-read.",
  "",
  "The index lives in .orchestra/codegraph.db of the project. A project with a few hundred files is indexed on the",
  "first query; a larger one answers that it needs the index action first, because building its graph takes long",
  "enough to be worth an explicit step. Names resolve by last segment: a method call is recorded under the method",
  "name, not under the type it is called on, so callers of a very common name are approximate.",
].join("\n")

export const Plugin = {
  id: "orchestra.tool.codegraph",
  effect: Effect.fn("CodegraphTool.Plugin")(function* (ctx: Context) {
    const location = yield* Location.Service

    const run = Effect.fn("CodegraphTool.run")(function* (input: Input) {
      if (input.action !== "status" && input.action !== "index" && !input.name?.trim())
        return yield* new ToolFailure({ message: `codegraph ${input.action} needs a name.` })
      return yield* Effect.try({
        try: () => answer(location.project.directory, input),
        catch: (error) => new ToolFailure({ message: `codegraph ${input.action} failed: ${message(error)}`, error }),
      })
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, core: true },
          description,
          input: Input,
          output: Output,
          execute: (input) => run(input).pipe(Effect.map((output) => ({ output: { output }, content: output }))),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

function answer(root: string, input: Input) {
  if (input.action === "status") return renderStatus(status(root))
  if (input.action === "index") return renderIndex(indexProject(root, { force: input.force }))
  if (!ensureIndexed(root))
    return `The code graph of this project is not built yet. Run the "index" action first (${status(root).database}).`
  const wanted = input.name?.trim() ?? ""
  if (input.action === "search") return renderSearch(wanted, find(root, wanted, input.limit ?? 20))
  if (input.action === "impact") {
    const result = impact(root, wanted, input.depth ?? 3)
    return result === undefined ? `No symbol matches "${wanted}".` : renderImpact(result)
  }
  const result = explore(root, wanted)
  return result === undefined ? `No symbol matches "${wanted}".` : renderExplore(result)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
