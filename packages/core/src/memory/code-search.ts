/**
 * Code search under the three-level memory (Б17): the xerj node.
 *
 * xerj is the pilot winner (news run6 №5, beat graphify №2 on the same
 * six agent questions over packages/core/src: same accuracy, ~35% fewer
 * answer tokens, ~5x faster to index, ~5x faster per query). It is an
 * MCP server, not a daemon Orchestra manages: the operator starts one
 * local node, indexes the project once, and the catalog entry points
 * sessions at it. See AI_ATLAS.md ("Code search (xerj)").
 *
 * Two invariants live here as code, not prose:
 * - the node is loopback-only: Orchestra never points at a remote node,
 *   because the index holds the whole codebase;
 * - the shipped MCP command never carries --insecure: the node runs with
 *   auth on by default (XERJ_API_KEY from <data_dir>/admin.key), and
 *   --insecure is a local-sandbox flag only.
 */

/** Environment variable naming the node URL (default {@link DEFAULT_NODE_URL}). */
export const NODE_URL_ENV = "XERJ_URL"

/** Environment variable carrying the node API key (read from <data_dir>/admin.key). */
export const NODE_API_KEY_ENV = "XERJ_API_KEY"

/** The xerj node's default ES-compatible listener (loopback, auth on). */
export const DEFAULT_NODE_URL = "http://127.0.0.1:9200"

/** The MCP command the catalog entry runs: stdio server against a running node. */
export const mcpCommand = (url: string = DEFAULT_NODE_URL): readonly string[] => [
  "xerj",
  "mcp",
  "--url",
  url,
  "--disable-feedback",
]

/** The node URL for this process: XERJ_URL when set and non-blank, else the default. */
export const nodeUrlFromEnv = (env: Record<string, string | undefined> = process.env): string => {
  const raw = env[NODE_URL_ENV]?.trim()
  if (raw === undefined || raw === "") return DEFAULT_NODE_URL
  return raw
}

/**
 * Why this node URL must not be used, or undefined when it is a loopback
 * http(s) URL. A remote node is refused even over https: the index is the
 * codebase, and there is no reason for Orchestra to read it over a network.
 */
export const loopbackProblem = (url: string): string | undefined => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `not a URL: ${url}`
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `not http(s): ${url}`
  if (parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost") return undefined
  return `not a loopback node: ${url}`
}
