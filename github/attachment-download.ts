// Attachment bodies are untrusted input. A regex match alone is not a URL
// boundary, and an allowed starting URL does not authorize arbitrary redirects.
const REDIRECT_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "user-attachments.githubusercontent.com",
  "private-user-images.githubusercontent.com",
])

export function attachmentURL(value: string, initial = true): URL {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.port || !REDIRECT_HOSTS.has(url.hostname))
    throw new Error("Attachment URL is outside the approved GitHub hosts")
  if (initial && (url.hostname !== "github.com" || !url.pathname.startsWith("/user-attachments/")))
    throw new Error("Expected a GitHub user attachment URL")
  return url
}

export async function downloadAttachment(value: string, accessToken: string, request: typeof fetch = fetch): Promise<Response> {
  let url = attachmentURL(value)
  for (let redirects = 0; redirects <= 3; redirects++) {
    const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" }
    // Never forward the account credential to an attachment CDN.
    if (url.hostname === "github.com") headers.Authorization = `Bearer ${accessToken}`
    const response = await request(url.href, { headers, redirect: "manual" })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get("location")
    await response.body?.cancel()
    if (!location || redirects === 3) throw new Error("Attachment redirect could not be followed safely")
    url = attachmentURL(new URL(location, url).href, false)
  }
  throw new Error("Attachment redirect limit reached")
}
