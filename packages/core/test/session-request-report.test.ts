import { describe, expect, test } from "bun:test"
import { utimes } from "node:fs/promises"
import path from "path"
import { Effect } from "effect"
import { SessionRequestReport } from "@orchestra/core/session/request-report"
import type { LLMRequest } from "@orchestra/ai"
import { tmpdir } from "./fixture/tmpdir"

describe("SessionRequestReport.redactSecrets", () => {
  test("redacts keys, tokens, passwords and private keys but keeps the surrounding text", () => {
    expect(SessionRequestReport.redactSecrets("key is sk-abcdefghij1234567890 here")).toBe(
      "key is [redacted] here",
    )
    expect(SessionRequestReport.redactSecrets('{"api_key": "sk-abcdefghij1234567890"}')).toBe(
      '{"api_key": "[redacted]"}',
    )
    expect(SessionRequestReport.redactSecrets("ORCHESTRA_PASSWORD=hunter2-hunter2")).toBe(
      "ORCHESTRA_PASSWORD=[redacted]",
    )
    expect(SessionRequestReport.redactSecrets("Authorization: Bearer abcdefghij1234567890")).toBe(
      "Authorization: Bearer [redacted]",
    )
    expect(SessionRequestReport.redactSecrets('{"Authorization": "Bearer abcdefghij1234567890"}')).toBe(
      '{"Authorization": "Bearer [redacted]"}',
    )
    expect(SessionRequestReport.redactSecrets("https://user:s3cret@example.com/x")).toBe(
      "https://user:[redacted]@example.com/x",
    )
    expect(
      SessionRequestReport.redactSecrets(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      ),
    ).toBe("[redacted private key]")
    expect(SessionRequestReport.redactSecrets("ghp_abcdefghij1234567890")).toBe("[redacted]")
  })

  test("leaves ordinary prose untouched", () => {
    const text = "Run bun test and report the failing test names."
    expect(SessionRequestReport.redactSecrets(text)).toBe(text)
  })
})

const request = {
  model: { provider: "anymodel", id: "sonnet-5" },
  system: [{ text: "You are an agent. The key is sk-abcdefghij1234567890." }],
  tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
} as unknown as LLMRequest

describe("SessionRequestReport.write", () => {
  test("writes the redacted report and prunes files older than the retention window", async () => {
    await using dir = await tmpdir()
    const directory = path.join(dir.path, "requests")
    const oldFile = path.join(directory, "old.json")
    const freshFile = path.join(directory, "fresh.json")
    await Bun.write(oldFile, "{}")
    await Bun.write(freshFile, "{}")
    await utimes(oldFile, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), new Date(Date.now() - 10 * 24 * 60 * 60 * 1000))

    await Effect.runPromise(
      SessionRequestReport.write({ sessionID: "ses_report_test", agent: "test", request }, directory),
    )

    expect(await Bun.file(oldFile).exists()).toBe(false)
    expect(await Bun.file(freshFile).exists()).toBe(true)
    const [written] = (await Array.fromAsync(new Bun.Glob("ses_report_test-*.json").scan({ cwd: directory }))) as [
      string,
    ]
    expect(written).toBeTruthy()
    const content = await Bun.file(path.join(directory, written)).text()
    expect(content).not.toContain("sk-abcdefghij1234567890")
    expect(content).toContain("[redacted]")
    expect(JSON.parse(content).model).toBe("anymodel/sonnet-5")
  })

  test("retention defaults to 7 days", () => {
    delete process.env.ORCHESTRA_REQUEST_REPORT_RETENTION_DAYS
    expect(SessionRequestReport.retentionDays()).toBe(7)
    process.env.ORCHESTRA_REQUEST_REPORT_RETENTION_DAYS = "30"
    expect(SessionRequestReport.retentionDays()).toBe(30)
    process.env.ORCHESTRA_REQUEST_REPORT_RETENTION_DAYS = "junk"
    expect(SessionRequestReport.retentionDays()).toBe(7)
    delete process.env.ORCHESTRA_REQUEST_REPORT_RETENTION_DAYS
  })
})
