/**
 * Canonical Plugin Categories across Orchestra.
 * Used for structured presentation in TUI, CLI, and Agent tools.
 */

export const PLUGIN_CATEGORIES = [
  "Auth & Identity",
  "Providers & Models",
  "Tools & Automation",
  "Skills & Knowledge",
  "UI & Rendering",
  "System & Workspace",
  "Other",
] as const

export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number]

/**
 * Deterministically categorize a plugin by its ID, package name, or file path target.
 */
export function categorizePlugin(id?: string, target?: string): PluginCategory {
  const text = `${id ?? ""} ${target ?? ""}`.toLowerCase().replace(/\\/g, "/")

  // 1. Auth & Identity
  if (
    text.includes("auth") ||
    text.includes("identity") ||
    text.includes("credential") ||
    text.includes("oauth")
  ) {
    return "Auth & Identity"
  }

  // 2. Providers & Models
  if (
    text.includes("provider") ||
    text.includes("models-dev") ||
    text.includes("zen-models") ||
    text.includes("chatgpt") ||
    text.includes("openai") ||
    text.includes("anthropic") ||
    text.includes("copilot") ||
    text.includes("azure") ||
    text.includes("digitalocean") ||
    text.includes("freebuff") ||
    text.includes("modal") ||
    text.includes("cohere") ||
    text.includes("perplexity") ||
    text.includes("bedrock") ||
    text.includes("gemini") ||
    text.includes("groq") ||
    text.includes("mistral") ||
    text.includes("ollama") ||
    text.includes("proxy-manager") ||
    /(?:^|[./_-])model(?:s)?(?:[./_-]|$)/.test(text)
  ) {
    return "Providers & Models"
  }

  // 3. Skills & Knowledge
  if (
    text.includes("skill") ||
    text.includes("research") ||
    text.includes("idea-bank") ||
    text.includes("memory") ||
    text.includes("note") ||
    text.includes("symbol") ||
    text.includes("lsp") ||
    text.includes("knowledge")
  ) {
    return "Skills & Knowledge"
  }

  // 4. UI & Rendering
  if (
    text.includes("tui") ||
    text.includes("merman") ||
    text.includes("mermaid") ||
    text.includes("latex") ||
    text.includes("theme") ||
    text.includes("formatter") ||
    text.includes("session-ui") ||
    text.includes("gui")
  ) {
    return "UI & Rendering"
  }

  // 5. Tools & Automation
  if (
    text.includes("browser") ||
    text.includes("desktop") ||
    text.includes("playtest") ||
    text.includes("forge") ||
    text.includes("tool") ||
    text.includes("websearch") ||
    text.includes("webfetch") ||
    text.includes("shell") ||
    text.includes("patch") ||
    text.includes("mcp") ||
    text.includes("subagent") ||
    text.includes("peer") ||
    text.includes("dod") ||
    text.includes("plot") ||
    text.includes("federation") ||
    text.includes("question") ||
    text.includes("read") ||
    text.includes("write") ||
    text.includes("edit") ||
    text.includes("glob") ||
    text.includes("grep") ||
    text.includes("hub")
  ) {
    return "Tools & Automation"
  }

  // 6. System & Workspace
  if (
    text.includes("vcs") ||
    text.includes("git") ||
    text.includes("hg") ||
    text.includes("sandbox") ||
    text.includes("workspace") ||
    text.includes("worktree") ||
    text.includes("snapshot") ||
    text.includes("location") ||
    text.includes("policy") ||
    text.includes("instruction") ||
    text.includes("warming") ||
    text.includes("compat") ||
    text.includes("compaction") ||
    text.includes("verbosity") ||
    text.includes("optimize") ||
    text.includes("room") ||
    text.includes("agent") ||
    text.includes("team") ||
    text.includes("plan") ||
    text.includes("wellknown")
  ) {
    return "System & Workspace"
  }

  return "Other"
}

/**
 * Compare two categories according to canonical taxonomy display order.
 */
export function comparePluginCategories(a: PluginCategory, b: PluginCategory): number {
  const indexA = PLUGIN_CATEGORIES.indexOf(a)
  const indexB = PLUGIN_CATEGORIES.indexOf(b)
  return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB)
}
