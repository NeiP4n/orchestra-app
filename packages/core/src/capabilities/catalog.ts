export * as CapabilityCatalog from "./catalog.js"

import { all as hub } from "../hub/catalog/index.js"
import { all as mcp } from "../mcp/catalog.js"
import { hubGroup, mcpGroup, nativeGroup, type Definition } from "./registry.js"
export interface LocalIndex {
  /** IDs only: full instructions, package config and file paths do not enter this index. */
  native: readonly string[]
  plugins: readonly string[]
  skills: readonly string[]
}
export function definitions(index: LocalIndex): readonly Definition[] {
  return [
    ...hub.map(
      (row): Definition => ({
        id: "hub:" + row.id,
        kind: "hub",
        group: hubGroup(row.category),
        requires: [...(row.requires ?? [])],
        dangerous: row.danger === true,
      }),
    ),
    ...mcp.map(
      (row): Definition => ({
        id: "mcp:" + row.id,
        kind: "mcp",
        group: mcpGroup(row.id),
        requires: [...(row.requires ?? [])],
        dangerous: row.realScreen === true,
      }),
    ),
    ...[...new Set(index.native)].map(
      (name): Definition => ({
        id: "native:" + name,
        kind: "native",
        group: nativeGroup(name),
        requires: [],
        dangerous: "unknown",
      }),
    ),
    ...[...new Set(index.plugins)].map(
      (name): Definition => ({
        id: "plugin:" + name,
        kind: "plugin",
        group: "other",
        requires: [],
        dangerous: "unknown",
      }),
    ),
    ...[...new Set(index.skills)].map(
      (name): Definition => ({
        id: "skill:" + name,
        kind: "skill",
        group: "coordination",
        requires: [],
        dangerous: "unknown",
      }),
    ),
  ]
}
