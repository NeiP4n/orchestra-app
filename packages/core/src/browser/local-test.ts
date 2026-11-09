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
export const enabled = () => process.env.ORCHESTRA_BROWSER_LOCAL_TEST === "1"
export const allowed = (address: string | undefined) => enabled() && localPage(address)
