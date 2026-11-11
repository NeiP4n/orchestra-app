export * as CapabilityRegistry from "./registry.js"

/** Methods are the entry point; native tools, MCP and CLI recipes are adapters, not competing selectors.
 * This inventory has no execution, model, network, install, credential-value or configuration access. */
export const groups = [
  "code",
  "research",
  "browser",
  "files",
  "data",
  "version-control",
  "build",
  "operations",
  "security",
  "mobile",
  "memory",
  "coordination",
  "other",
] as const
export type Group = (typeof groups)[number]
export type State = "ready" | "disabled" | "unavailable" | "blocked" | "unknown"
export type Kind = "native" | "mcp" | "hub" | "plugin" | "skill"
export interface Definition {
  id: string
  kind: Kind
  group: Group
  /** Adapter IDs only, never executable command templates, paths, secrets or full skill text. */
  requires: readonly string[]
  dangerous: boolean | "unknown"
}
export interface Observed {
  state: State
  permission?: "allowed" | "denied" | "unknown"
  credential?: "ready" | "missing" | "unknown"
  cost?: "local-only" | "metered" | "unknown"
  spendApproved?: boolean
}
export interface Snapshot {
  version: 1
  at: number
  entries: readonly (Definition & Observed & { eligible: boolean })[]
}
const category: Readonly<Record<string, Group>> = {
  search: "code",
  files: "files",
  text: "files",
  json: "data",
  data: "data",
  git: "version-control",
  github: "version-control",
  docker: "build",
  build: "build",
  systemd: "operations",
  process: "operations",
  network: "operations",
  system: "operations",
  windows: "operations",
  security: "security",
  mobile: "mobile",
}
export const hubGroup = (value: string): Group => category[value] ?? "other"
export function nativeGroup(name: string): Group {
  if (/^(browser|webpage|browser_)/.test(name)) return "browser"
  if (/^(websearch|webfetch|search_web|research)/.test(name)) return "research"
  if (/^(grep|symbols|codegraph|glob)$/.test(name)) return "code"
  if (/^(read|write|edit|patch|apply_patch)$/.test(name)) return "files"
  if (/^(memory|journal|notes|lessons)/.test(name)) return "memory"
  if (/^(session|plan|stages|tasks|orchestra|skill)/.test(name)) return "coordination"
  if (/^(vault|security)/.test(name)) return "security"
  if (/^(shell|hub|terminal)/.test(name)) return "operations"
  return "other"
}
export function mcpGroup(name: string): Group {
  if (["context7", "deepwiki"].includes(name)) return "research"
  if (["serena", "xerj", "rea-anything"].includes(name)) return "code"
  if (name === "sentry") return "operations"
  return "other"
}
/** Snapshot is a dated observation, never a grant or a promise of execution. Unknown permission,
 * credential state or cost is NOT silently turned into permission, a usable key or free service. */
export function snapshot(
  definitions: readonly Definition[],
  observations: ReadonlyMap<string, Observed>,
  at: number,
): Snapshot {
  if (!Number.isSafeInteger(at) || at < 0) throw Error("Invalid snapshot time.")
  const seen = new Set<string>()
  const entries = definitions
    .map((definition) => {
      if (!definition.id || seen.has(definition.id)) throw Error("Duplicate or missing capability adapter ID.")
      seen.add(definition.id)
      const row = observations.get(definition.id)
      const permission = row?.permission ?? "unknown"
      const credential = row?.credential ?? "unknown"
      const cost = row?.cost ?? "unknown"
      const state = row?.state ?? "unknown"
      return {
        ...definition,
        requires: [...definition.requires],
        state,
        permission,
        credential,
        cost,
        eligible:
          state === "ready" &&
          permission === "allowed" &&
          credential === "ready" &&
          (cost === "local-only" || row?.spendApproved === true),
      }
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id))
  return { version: 1, at, entries }
}
export function summary(value: Snapshot): string[] {
  return [
    "Capability methods and adapters (read-only snapshot; not an execution grant):",
    ...groups.flatMap((group) => {
      const rows = value.entries.filter((row) => row.group === group)
      if (!rows.length) return []
      const kinds = [...new Set(rows.map((row) => row.kind))].sort().join(", ")
      return [
        `- ${group}: ${rows.length} adapters (${kinds}); ${rows.filter((row) => row.state === "ready").length} ready, ${rows.filter((row) => row.state === "disabled").length} OFF, ${rows.filter((row) => row.state === "unknown").length} unknown`,
      ]
    }),
    "Use the existing skill index/pick/load workflow for the method. Adapter readiness is separate from role permissions, credentials and cost. Unknown cost is not free. Revalidate before use. No adapter was started or enabled.",
  ]
}
