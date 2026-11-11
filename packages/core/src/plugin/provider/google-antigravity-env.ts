/** Fixed public configuration error. Never embeds environment values. */
export class AntigravityOAuthConfigurationError extends Error {
  readonly code = "missing_client_secret"
  constructor() {
    super("Antigravity OAuth configuration error: ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET is not set. Configure it locally and restart Orchestra.")
    this.name = "AntigravityOAuthConfigurationError"
  }
}

/** Read only when the Antigravity OAuth flow is used, not during provider discovery. */
export function requireAntigravityClientSecret(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
  if (!value?.trim()) {
    throw new AntigravityOAuthConfigurationError()
  }
  return value
}
