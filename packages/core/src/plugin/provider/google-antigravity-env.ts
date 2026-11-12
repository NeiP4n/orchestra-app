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
  if (!value?.trim() && !customAntigravityClient(env)) {
    throw new AntigravityOAuthConfigurationError()
  }
  return value?.trim() ?? ""
}

/** Only an explicitly selected non-default public client may omit its secret. Google validates it. */
export function customAntigravityClient(env: NodeJS.ProcessEnv = process.env) {
 const id=env.ORCHESTRA_ANTIGRAVITY_CLIENT_ID?.trim()
 return !!id && id !== "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
}
export function antigravityClientID(env: NodeJS.ProcessEnv = process.env) {
 return env.ORCHESTRA_ANTIGRAVITY_CLIENT_ID?.trim() || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
}
export function antigravityClientParams(env: NodeJS.ProcessEnv = process.env) {
 const secret=requireAntigravityClientSecret(env)
 return {client_id:antigravityClientID(env),...(secret ? {client_secret:secret} : {})}
}
