/** Read only when the Antigravity OAuth flow is used, not during provider discovery. */
export function requireAntigravityClientSecret(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
  if (!value?.trim()) {
    throw new Error("Не задана ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET: настройте OAuth client secret для Google Antigravity.")
  }
  return value
}
