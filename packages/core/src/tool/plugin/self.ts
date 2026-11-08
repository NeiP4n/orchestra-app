export * as SelfTool from "./self.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import { ToolFailure } from "@orchestra/ai"
import { optional } from "@orchestra/schema/schema"
import { Global } from "@orchestra/util/global"
import { Effect, Schema } from "effect"
import { Config } from "../../config.js"
import { ensureIndexed, explore, impact } from "../../codegraph/query.js"
import { renderExplore, renderImpact } from "../../codegraph/render.js"
import { ensureFresh, openStore, rebuild, searchDocs, selfRoot, status } from "../../self/index.js"
import { supported } from "../../self/store.js"
import type { Options } from "../../self/index.js"

export const name = "self"

export const Input = Schema.Struct({
  action: Schema.Literals(["search", "code", "status", "index"]),
  /** What to look for: a question or keywords for search, a symbol name for code. */
  query: optional(Schema.String),
  /** Maximum hits for search. */
  limit: optional(Schema.Number),
  /** How many caller rings the code action's impact walk covers. */
  depth: optional(Schema.Number),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  output: Schema.String,
})
export type Output = typeof Output.Type

export const description = [
  "Answer questions about Orchestra itself: its CLI commands, config keys, environment variables, built-in tools, extension points and its own documentation, plus symbol-level navigation of Orchestra's own code.",
  "TOOL CHOICE: use self ONLY for questions about Orchestra (how to configure it, what a command does, where an extension point lives, how its own code works). For the project you are working in use grep, symbols and codegraph instead.",
  "",
  "Actions:",
  "  search — keyword or natural-language search over the self index (commands, config, env vars, tools, docs, custom files).",
  "  code — one call for a symbol of Orchestra's own code: where it is declared, who calls it and what a change would touch.",
  "  status — what the self index holds, where it lives and whether it is fresh.",
  "  index — rebuild the self index now (it also rebuilds itself on start whenever sources changed).",
  "",
  "The index is rebuilt automatically on start when Orchestra's version or sources changed, and the operator can",
  "add their own documents through the `self_index.paths` config key.",
].join("\n")

export const Plugin = {
  id: "orchestra.tool.self",
  effect: Effect.fn("SelfTool.Plugin")(function* (ctx: Context) {
    const global = yield* Global.Service
    const config = yield* Config.Service

    const options = Effect.fn("SelfTool.options")(function* () {
      const entries = yield* config.entries()
      const setting = Config.latest(entries, "self_index")
      return {
        ...(setting?.paths ? { customPaths: setting.paths } : {}),
        ...(setting?.docs === false ? { docs: false } : {}),
      }
    })

    // Rebuilt on each start when the fingerprint moved: an update changes the
    // version define or the harvested files, and the next boot reindexes in
    // the background. A fresh check costs one stat per harvested file.
    yield* options().pipe(
      Effect.flatMap((current) =>
        Effect.try({
          try: () => ensureFresh(global.data, current),
          catch: (error) => new Error(`self index refresh failed: ${message(error)}`, { cause: error }),
        }),
      ),
      Effect.tap((result) =>
        result.rebuilt ? Effect.logInfo("self index rebuilt on boot", { documents: result.documents }) : Effect.void,
      ),
      Effect.catchAll((error) => Effect.logWarning(error.message)),
      Effect.forkScoped({ startImmediately: true }),
    )

    const run = Effect.fn("SelfTool.run")(function* (input: Input) {
      if ((input.action === "search" || input.action === "code") && !input.query?.trim())
        return yield* new ToolFailure({ message: `self ${input.action} needs a query.` })
      const current = yield* options()
      return yield* Effect.try({
        try: () => answer(global.data, current, input),
        catch: (error) => new ToolFailure({ message: `self ${input.action} failed: ${message(error)}`, error }),
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

function answer(dataDir: string, options: Options, input: Input): string {
  const root = selfRoot()
  if (!root)
    return "The self index is unavailable in this build: it needs to run from an Orchestra source tree, and this process does not."
  if (!supported())
    return "The self index is unavailable in this build: it needs the Bun sqlite engine. Use the Bun build for the self index."

  if (input.action === "status") return renderStatus(status(dataDir, options))
  if (input.action === "index") {
    const result = rebuild(dataDir, options)
    return `Self index rebuilt: ${result.documents} documents in ${result.durationMs} ms (fingerprint ${result.fingerprint}).`
  }

  if (input.action === "code") {
    const wanted = input.query!.trim()
    if (!ensureIndexed(root))
      return `Orchestra's own code graph is not built yet (${root}). Run the codegraph tool's index action from the Orchestra checkout first.`
    const found = explore(root, wanted)
    if (found !== undefined) return renderExplore(found)
    const blast = impact(root, wanted, input.depth ?? 3)
    return blast === undefined ? `No symbol matches "${wanted}" in Orchestra's own code.` : renderImpact(blast)
  }

  // search: make sure one boot of the current sources happened, then answer.
  ensureFresh(dataDir, options)
  const store = openStore(dataDir)
  try {
    const hits = searchDocs(store, input.query!.trim(), input.limit ?? 8)
    if (hits.length === 0) return `Nothing in the self index matches "${input.query}".`
    return hits
      .map(
        (hit) =>
          `[${hit.kind}] ${hit.title} (score ${hit.score})${hit.path ? `\n    ${hit.path}` : ""}\n    ${hit.snippet.replace(/\n/g, "\n    ")}`,
      )
      .join("\n\n")
  } finally {
    store.db.close()
  }
}

function renderStatus(info: ReturnType<typeof status>): string {
  if (!info.available) return `Self index unavailable: ${info.reason}.`
  return [
    `Self index at ${info.database}`,
    `  source root: ${info.root}`,
    `  documents: ${info.documents ?? 0}`,
    `  fresh: ${info.fresh === true ? "yes" : "no — a rebuild happens on the next index action or boot"}`,
  ].join("\n")
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
