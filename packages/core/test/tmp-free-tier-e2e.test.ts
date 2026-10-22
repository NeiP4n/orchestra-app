import { describe, expect, test } from "bun:test"
import { RequestExecutor } from "@orchestra/ai/route"
import { SessionRunnerRetry } from "@orchestra/core/session/runner/retry"
import { asRateLimit, toSessionError } from "@orchestra/core/session/to-session-error"

// The exact body the Zen console answers a spent free-tier address with.
const zenBody = JSON.stringify({
  type: "error",
  error: { type: "FreeUsageLimitError", message: "Rate limit exceeded. Please try again later." },
})

describe("free tier end to end", () => {
  test("a real Zen 429 body is reclassified as a retryable rate limit", () => {
    const failure = RequestExecutor.httpFailure({
      message: "Rate limit exceeded. Please try again later.",
      url: "https://opencode.ai/zen/v1/messages",
      status: 429,
      responseBody: zenBody,
    })
    // The provider layer files this under the account quota.
    expect(failure.reason._tag).toBe("QuotaExceeded")
    expect(failure.reason.body).toContain("FreeUsageLimitError")

    // The session layer reclassifies it as a throttle.
    const error = toSessionError(failure)
    expect(error.type).toBe("provider.rate-limit")
    expect(error.status).toBe(429)
    expect(error.message).toContain("per IP address")
    expect(SessionRunnerRetry.isRetryable(asRateLimit(failure))).toBe(true)
  })

  test("a real Zen account-cap body stays a quota", () => {
    const failure = RequestExecutor.httpFailure({
      message: "Go usage limit exceeded",
      url: "https://opencode.ai/zen/v1/messages",
      status: 429,
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" },
      }),
    })
    expect(failure.reason._tag).toBe("QuotaExceeded")
    expect(toSessionError(failure).type).toBe("provider.quota")
  })
})
