export * as ProjectTemplateRuntimeRoles from "./project-template-runtime-roles.js"

import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { Agent } from "@orchestra/schema/agent"
import type { ProjectTemplateV2 as V2 } from "./project-template-v2.js"

/** Complete runtime reuse snapshot, not a Team-role replacement. Full permissions,
 * system, request settings and model are preserved. Only source-owned plan directory
 * rules use exact placeholders for the destination equivalents.
 * Destination equality is mandatory, including checks at its actual new directory. */
export function portable(runtime: Agent.Info, roots?: { config: string; home: string }): V2.Role {
  const snapshot = structuredClone(runtime)
  if (roots) snapshot.permissions = snapshot.permissions.map(rule => {
    const config = path.join(roots.config, "plan", "*"), legacy = path.join(roots.home, ".opencode", "plan", "*")
    if (runtime.id === "plan" && rule.action === "edit" && rule.resource === config)
      return { ...rule, resource: "{{runtime.planDirectory}}/*" }
    if (runtime.id === "plan" && rule.action === "external_directory" && rule.resource === legacy)
      return { ...rule, resource: "{{runtime.legacyPlanDirectory}}/*" }
    return rule
  })
  return {
    agent: runtime.id, name: runtime.name, description: runtime.description ?? "",
    rules: "", category: "Runtime", readOnly: false, runtime: snapshot,
  }
}
export function merge(catalogs: readonly (readonly Agent.Info[])[], roots?: { config: string; home: string }): V2.Role[] {
  const definitions = new Map<string, V2.Role>()
  for (const catalog of catalogs) for (const info of catalog) {
    const definition = portable(info, roots), previous = definitions.get(info.id)
    if (previous && !isDeepStrictEqual(previous, definition))
      throw Error("Runtime role differs between owned source session locations. No template was prepared.")
    definitions.set(info.id, definition)
  }
  return [...definitions.values()]
}

