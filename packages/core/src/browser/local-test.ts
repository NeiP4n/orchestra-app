import { SafetyConfig } from "../safety-config.js"
export * as BrowserLocalTest from "./local-test.js"

/** Exact loopback hosts only. No suffix matches, credentials or remote file shares. */
export function localPage(address: string | undefined): boolean {
  if (!address) return false
  try {
    const url = new URL(address)
    if (url.username || url.password) return false
    if (url.protocol === "file:") return !url.host && !url.pathname.startsWith("//")
    return (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  } catch { return false }
}
export const enabled = () => process.env.ORCHESTRA_BROWSER_LOCAL_TEST === undefined ? SafetyConfig.read().localTest === true : process.env.ORCHESTRA_BROWSER_LOCAL_TEST === "1"
export const allowed = (address: string | undefined) => enabled() && localPage(address)

/** Never return page content captured during a navigation out of the fixture. */
export async function read<T>(address: () => Promise<string | undefined>, capture: () => Promise<T>): Promise<T> {
  if (!allowed(await address())) throw new Error("Local fixture check refused before read: page is not local or test mode is off.")
  const result = await capture()
  if (!allowed(await address())) throw new Error("Local fixture check discarded after read: page left the local gate or test mode is off.")
  return result
}
