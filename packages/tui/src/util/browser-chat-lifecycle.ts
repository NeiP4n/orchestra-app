import { isSessionNotFoundError } from "@orchestra/client"

/** Only the typed missing-session response proves an obsolete binding. A timeout,
 * auth failure or missing local cache entry must never erase or replace a chat. */
export async function browserChat<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read() }
  catch (error) { if (isSessionNotFoundError(error)) return undefined; throw error }
}

/** Deletion is idempotent only for a server-confirmed missing session. */
export async function removeBrowserChat(remove: () => Promise<unknown>) {
  await browserChat(remove)
}
