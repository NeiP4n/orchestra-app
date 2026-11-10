export * as ProjectTemplateLinkReview from "./project-template-link-review.js"
import { countSecrets } from "./memory/scrub.js"
export const reasons = ["credentials", "query", "fragment", "local", "scheme", "secret", "invalid"] as const
export type Reason = (typeof reasons)[number]
export interface Issue {
  browser: number
  link: number
  reason: Reason
}
/** Never return a URL, title, host, query value or browser name. Ordinals locate the saved
 * entry without exposing even an opaque token hidden in a path or subdomain. */
export function reason(value: string): Reason | undefined {
  try {
    const url = new URL(value)
    if (!["https:", "http:"].includes(url.protocol)) return "scheme"
    if (url.username || url.password) return "credentials"
    if (url.search) return "query"
    if (url.hash) return "fragment"
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      !host.includes(".") ||
      /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) ||
      (host.includes(":") && /^(?:::|f[cd]|fe[89ab])/.test(host))
    )
      return "local"
    const decoded = decodeURIComponent(value)
    if (value.length > 2048 || countSecrets(value) || countSecrets(decoded) || /[\x00-\x20\x7f]/.test(value))
      return "secret"
  } catch {
    return "invalid"
  }
}
