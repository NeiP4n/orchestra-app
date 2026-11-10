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
