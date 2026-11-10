import type { Entry } from "@orchestra/schema/config"

/** Installation is persisted configuration, not a live connection. Global MCP OFF, missing
 * credentials or a failed process must never make the Registry offer installation again. */
export function mcpRegistryState(entries: readonly Entry[]) {
  const servers = new Map<string, { disabled?: boolean }>()
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const [name, config] of Object.entries(entry.info.mcp?.servers ?? {})) servers.set(name, config)
  }
  return {
    installed: [...servers.keys()].sort(),
    disabled: [...servers]
      .filter(([, config]) => config.disabled === true)
      .map(([name]) => name)
      .sort(),
  }
}

/** Toggling an installed adapter must not replace custom commands, endpoints or timeout settings
 * with the catalog defaults. Newly installed adapters still use the selected catalog recipe. */
export function mcpRegistryToggle(entries: readonly Entry[], id: string, requested: import("@orchestra/schema/mcp").ServerConfig | null) {
  let existing: import("@orchestra/schema/mcp").ServerConfig | undefined
  for (const entry of entries) if (entry.type === "document" && entry.info.mcp?.servers?.[id]) existing = entry.info.mcp.servers[id]
  return existing && requested ? { ...existing, disabled: requested.disabled === true } : requested
}
