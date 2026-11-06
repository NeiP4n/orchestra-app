import { describe, expect, test } from "bun:test"
import { CodeModeWeb } from "@orchestra/core/codemode/web"

const fetch = CodeModeWeb.extension.globals.fetch as (input: string) => Promise<{
  readonly status: number
  readonly text: () => Promise<string>
}>

/**
 * The SSRF gate on Code Mode fetch: agent code cannot read the operator's LAN, localhost
 * services or the cloud metadata endpoint through fetch, including via redirects.
 */
describe("CodeModeWeb.fetch", () => {
  test("refuses private, loopback and metadata URLs before any request", async () => {
    for (const url of [
      "http://127.0.0.1:17890/api/test",
      "http://localhost:11434/",
      "http://10.0.0.5/admin",
      "http://192.168.1.10/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
    ]) {
      await expect(fetch(url), url).rejects.toThrow("Refusing to fetch")
    }
  })

  test("lets a public URL through the gate", async () => {
    // The sandbox may or may not reach the public internet; what matters here is the gate:
    // a public URL must not be refused by it. A network failure proves the gate passed.
    const outcome = await Promise.race([
      fetch("https://example.com/")
        .then((response) => ({ ok: true, status: response.status }))
        .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "test timed out" }), 10_000)),
    ])
    if (!outcome.ok) expect(outcome.error).not.toContain("Refusing to fetch")
  })
})
