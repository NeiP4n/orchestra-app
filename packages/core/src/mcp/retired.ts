/** Removed from the built-in registry, not from the operator's personal MCP configuration or tool ceilings. */
export const RETIRED_CATALOG_SERVERS: ReadonlySet<string> = new Set([
  "playwright",
  "chrome-devtools",
  "agent-desktop",
  "github",
])
/** Safety classification survives registry removal for manually configured real-screen tools. */
export const REAL_SCREEN_SERVER_IDS: ReadonlySet<string> = new Set(["playwright", "agent-desktop"])
