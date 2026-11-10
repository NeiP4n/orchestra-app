export * as CapabilityInspect from "./inspect.js"

import { definitions } from "./catalog.js"
import { snapshot, type Observed } from "./registry.js"
export interface Facts {
  at: number
  mcpEnabled: boolean
  mcp: readonly { name: string; disabled: boolean; status: string; tools: readonly string[] }[]
  native: readonly string[]
  skills: readonly string[]
  plugins: readonly { id: string; disabled: boolean }[]
}
/** Facts come from local metadata readers only. No probes, connects, installs or key-value reads.
 * Program presence and per-task grants are not supplied by this reader, so remain unknown. */
export function inspect(facts: Facts) {
  const rows = definitions({ native: facts.native, skills: facts.skills, plugins: facts.plugins.map((row) => row.id) })
  const observed = new Map<string, Observed>()
  for (const row of rows.filter((row) => row.kind === "mcp")) {
    const server = facts.mcp.find((item) => "mcp:" + item.name === row.id)
    const state =
      !facts.mcpEnabled || server?.disabled || server?.status === "disabled"
        ? "disabled"
        : !server
          ? "unavailable"
          : server.status === "connected" && server.tools.length > 0
            ? "ready"
            : ["failed", "needs_auth"].includes(server.status)
              ? "blocked"
              : "unknown"
    observed.set(row.id, {
      state,
      credential: state === "ready" ? "ready" : server?.status === "needs_auth" ? "missing" : "unknown",
    })
  }
  for (const name of facts.native) observed.set("native:" + name, { state: "ready" })
  // Indexed skill != loaded method. Configured plugin != loaded plugin.
  for (const plugin of facts.plugins)
    observed.set("plugin:" + plugin.id, { state: plugin.disabled ? "disabled" : "unknown" })
  return snapshot(rows, observed, facts.at)
}

/** Runtime-local registered methods, not the fixed native-analogue shortlist. Plugin methods
 * registered into the same local tool registry are included; MCP namespaces stay separate. */
export function localToolIDs(
  tools: readonly { id: string; options?: { namespace?: string } }[],
  mcpServers: readonly string[],
): readonly string[] {
  const namespaces = new Set(mcpServers.map((name) => name.replace(/[^a-zA-Z0-9_-]/g, "_")))
  return [
    ...new Set(
      tools.filter((row) => !row.options?.namespace || !namespaces.has(row.options.namespace)).map((row) => row.id),
    ),
  ]
}
