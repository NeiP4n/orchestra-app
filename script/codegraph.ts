#!/usr/bin/env bun
// The code graph from a terminal, for a person or an agent that does not run the server.
//
// Usage:
//   bun script/codegraph.ts search createSociety
//   bun script/codegraph.ts explore createSociety
//   bun script/codegraph.ts impact createSociety --depth 2
//   bun script/codegraph.ts index [--force]
//   bun script/codegraph.ts stats
//
// Options: --root <dir> (defaults to the working directory), --limit <n>, --depth <n>, --force.
//
// The modules are imported by relative path on purpose: the CLI must run from a checkout without the
// server, the Effect layer or a resolved workspace link.
import path from "node:path"
import { indexProject } from "../packages/core/src/codegraph/indexer.ts"
import { ensureIndexed, explore, impact, search, status } from "../packages/core/src/codegraph/query.ts"
import {
  renderExplore,
  renderImpact,
  renderIndex,
  renderSearch,
  renderStatus,
} from "../packages/core/src/codegraph/render.ts"

const args = process.argv.slice(2)
const options = new Map<string, string | true>()
const positionals: string[] = []

for (let index = 0; index < args.length; index++) {
  const argument = args[index]!
  if (!argument.startsWith("--")) {
    positionals.push(argument)
    continue
  }
  const next = args[index + 1]
  if (next !== undefined && !next.startsWith("--")) {
    options.set(argument.slice(2), next)
    index++
    continue
  }
  options.set(argument.slice(2), true)
}

const text = (key: string) => {
  const value = options.get(key)
  return typeof value === "string" ? value : undefined
}
const number = (key: string) => {
  const value = text(key)
  return value === undefined ? undefined : Number(value)
}

const [command, name] = positionals
const root = path.resolve(text("root") ?? process.cwd())

if (command === undefined || options.has("help")) {
  console.log(
    [
      "usage: bun script/codegraph.ts <command> [name] [options]",
      "",
      "  search <name>   declarations whose name matches",
      "  explore <name>  declaration, callers, callees and importers in one answer",
      "  impact <name>   callers at increasing depth, plus the files to re-check",
      "  index           build or refresh the index (--force re-reads every file)",
      "  stats           what the index holds at --root",
      "",
      "options: --root <dir>  --limit <n>  --depth <n>  --force",
    ].join("\n"),
  )
  process.exit(command === undefined ? 1 : 0)
}

if (command === "index") {
  console.log(renderIndex(indexProject(root, { force: options.has("force") })))
  process.exit(0)
}

if (command === "stats") {
  console.log(renderStatus(status(root)))
  process.exit(0)
}

const state = status(root)
if (!ensureIndexed(root)) {
  console.error(`No code graph at ${state.database}. Run "bun script/codegraph.ts index" first.`)
  process.exit(1)
}

if (command === "search") {
  const wanted = name ?? ""
  const hits = search(root, wanted, number("limit") ?? 20)
  console.log(renderSearch(wanted, hits))
  process.exit(hits.length === 0 ? 1 : 0)
}

if (command === "explore") {
  const wanted = name ?? ""
  const result = explore(root, wanted)
  console.log(result === undefined ? `No symbol matches "${wanted}".` : renderExplore(result))
  process.exit(result === undefined ? 1 : 0)
}

if (command === "impact") {
  const wanted = name ?? ""
  const result = impact(root, wanted, number("depth") ?? 3)
  console.log(result === undefined ? `No symbol matches "${wanted}".` : renderImpact(result))
  process.exit(result === undefined ? 1 : 0)
}

console.error(`unknown command "${command}"`)
process.exit(1)
