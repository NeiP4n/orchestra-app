// Compact text rendering of the graph answers.
//
// A model reads these strings, so every line carries a location it can jump to and nothing else. The
// whole answer is bounded: a query on a popular name must not spend the context of a whole file.

import type { ExploreResult, GraphStatus, ImpactResult, IndexReport, SearchHit, Symbol } from "./types.js"

export const LIMIT = 4096

export function clip(text: string, limit = LIMIT) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 24).trimEnd()}\n... (truncated)`
}

export function renderSearch(term: string, hits: readonly SearchHit[]) {
  if (hits.length === 0) return `No symbol matches "${term}".`
  return clip([`${hits.length} match(es) for "${term}":`, ...hits.map((hit) => `  ${describe(hit.symbol)}`)].join("\n"))
}

export function renderExplore(result: ExploreResult) {
  const lines = [
    `${result.symbol.name}  ${describe(result.symbol)}`,
    result.callers.length === 0 ? "callers: none" : `callers (${result.callers.length}):`,
    ...result.callers.map((caller) => `  ${caller.name}  ${caller.kind}  ${caller.path}:${caller.line}`),
    result.callees.length === 0 ? "callees: none" : `callees (${result.callees.length}):`,
    ...result.callees.map((callee) => `  ${callee.name}  ${callee.path}:${callee.line}  x${callee.calls}`),
    result.importers.length === 0 ? "importers: none" : `importers (${result.importers.length}):`,
    ...result.importers.map((importer) => `  ${importer}`),
  ]
  return clip(lines.join("\n"))
}

export function renderImpact(result: ImpactResult) {
  const files = result.files.length
  const lines = [
    `${result.target.name}  ${describe(result.target)}`,
    `${result.total} caller(s) in ${result.rings.length} ring(s) across ${files} file(s)${result.truncated ? " (truncated)" : ""}`,
    ...result.rings.flatMap((ring) => [
      `depth ${ring.depth} (${ring.callers.length}):`,
      ...ring.callers.map((caller) => `  ${caller.name}  ${caller.path}:${caller.line}`),
    ]),
    ...(result.ambiguous.length === 0 ? [] : [`not expanded (shared name): ${result.ambiguous.join(", ")}`]),
    `files: ${result.files.join(", ")}`,
  ]
  return clip(lines.join("\n"))
}

export function renderStatus(status: GraphStatus) {
  if (!status.indexed) return `No index yet at ${status.database}. Run the "index" action to build it.`
  const when = status.indexedAt === undefined ? "" : `, built ${new Date(status.indexedAt).toISOString()}`
  return `${status.files} file(s), ${status.symbols} symbol(s), ${status.edges} edge(s) in ${status.database}${when}`
}

export function renderIndex(report: IndexReport) {
  return [
    `Indexed ${report.indexed} file(s), ${report.removed} removed, ${report.unchanged} unchanged of ${report.files} in ${report.milliseconds} ms.`,
    `${report.symbols} symbol(s) and ${report.edges} edge(s) in ${report.database}.`,
  ].join("\n")
}

function describe(symbol: Symbol) {
  const where = `${symbol.path}:${symbol.line}`
  const container = symbol.container === undefined ? "" : ` in ${symbol.container}`
  return `${symbol.kind}${container}  ${where}${symbol.exported ? "  export" : ""}`
}
