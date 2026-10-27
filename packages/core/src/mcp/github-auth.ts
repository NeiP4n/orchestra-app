export * as McpGitHubAuth from "./github-auth.js"

import { Mcp } from "@orchestra/schema/mcp"
import { Effect } from "effect"
import { execFile } from "node:child_process"

/** Hosts whose MCP endpoint accepts a GitHub token as a bearer credential. */
export const HOSTS = new Set(["api.githubcopilot.com", "api.github.com"])

const hasAuthorization = (headers: Readonly<Record<string, string>> | undefined) =>
  Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "authorization")

/**
 * Adds the operator's GitHub CLI token to a remote GitHub MCP server that has no bearer header.
 * GitHub's MCP endpoint does not support dynamic client registration, so OAuth cannot start; the
 * token `gh auth login` already stored is the credential the operator expects to be reused.
 */
export const withToken = (config: Mcp.ServerConfig, token: string | undefined) => {
  if (config.type !== "remote" || token === undefined || token === "") return config
  const url = URL.canParse(config.url) ? new URL(config.url) : undefined
  if (!url || !HOSTS.has(url.hostname.toLowerCase())) return config
  if (hasAuthorization(config.headers)) return config
  return { ...config, headers: { ...config.headers, Authorization: `Bearer ${token}` } }
}

/** Reads the token of the GitHub CLI session, if the CLI is installed and signed in. */
export const fromCli = Effect.fnUntraced(function* () {
  return yield* Effect.tryPromise({
    try: () =>
      new Promise<string | undefined>((resolve) => {
        execFile("gh", ["auth", "token"], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
          if (error) return resolve(undefined)
          const token = stdout.trim()
          resolve(token === "" ? undefined : token)
        })
      }),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))
})

/** The remote config to connect with: gh's token when available, the configured one otherwise. */
export const prepare = Effect.fnUntraced(function* (config: Mcp.ServerConfig) {
  const token = yield* fromCli()
  return { config: withToken(config, token), token }
})
