import { describe, expect, test } from "bun:test"
import {
  AIError,
  AuthenticationError,
  ContentPolicyError,
  HttpContext,
  InvalidProviderOutputError,
  InvalidRequestError,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnknownProviderError,
} from "@orchestra/ai"
import {
  MAIN_SESSION_FALLBACK_MODELS,
  TABLE,
  classifyError,
} from "@orchestra/core/session/runner/error-taxonomy"
import { ladder } from "@orchestra/core/session/runner/escalate"

const failure = (reason: ConstructorParameters<typeof AIError>[0]["reason"]) => new AIError({ reason })
const http = (status: number) => new HttpContext({ url: "https://provider.example/v1", status, headers: {} })

describe("SessionErrorTaxonomy", () => {
  test("covers every code from A1 to J15 with a bounded handler", () => {
    const codes = Object.keys(TABLE)
    expect(codes.length).toBe(101)
    for (const [code, entry] of Object.entries(TABLE)) {
      expect(entry.code).toBe(code)
      expect(["retry", "full-retry", "switch-model", "pause", "escalate", "fail-fast"]).toContain(entry.action)
      expect(entry.maxRetries).toBeGreaterThanOrEqual(0)
      expect(entry.maxRetries).toBeLessThanOrEqual(2)
      expect(entry.title.length).toBeGreaterThan(0)
    }
  })

  test("429 pauses, quota and auth escalate without retries", () => {
    expect(classifyError(failure(new RateLimitError({ message: "Too many requests" })))).toMatchObject({
      code: "A1",
      action: "pause",
      maxRetries: 2,
    })
    expect(classifyError(failure(new QuotaExceededError({ message: "insufficient_quota" })))).toMatchObject({
      code: "A2",
      action: "escalate",
      maxRetries: 0,
    })
    expect(classifyError(failure(new AuthenticationError({ message: "incorrect api key" })))).toMatchObject({
      code: "A3",
      action: "escalate",
      maxRetries: 0,
    })
  })

  test("404 model switches model, 500/502/408 retry, 409 fails fast", () => {
    expect(
      classifyError(failure(new InvalidRequestError({ message: "model_not_found", http: http(404) }))),
    ).toMatchObject({ code: "A4", action: "switch-model", maxRetries: 0 })
    expect(
      classifyError(failure(new ProviderInternalError({ message: "internal", http: http(500) }))),
    ).toMatchObject({ code: "A5", action: "retry", maxRetries: 2 })
    expect(
      classifyError(failure(new ProviderInternalError({ message: "bad gateway", http: http(502) }))),
    ).toMatchObject({ code: "A6", action: "retry", maxRetries: 2 })
    expect(classifyError(failure(new TimeoutError({ message: "deadline", timeoutMs: 1000 })))).toMatchObject({
      code: "A7",
      action: "retry",
      maxRetries: 2,
    })
    expect(
      classifyError(failure(new InvalidRequestError({ message: "conflict", http: http(409) }))),
    ).toMatchObject({ code: "A8", action: "fail-fast", maxRetries: 0 })
  })

  test("stream cut after first tokens retries fully once, broken tool-call JSON retries once", () => {
    expect(
      classifyError(
        failure(new InvalidProviderOutputError({ message: "stream ended early", classification: "incomplete-stream" })),
      ),
    ).toMatchObject({ code: "A10", action: "full-retry", maxRetries: 1 })
    expect(
      classifyError(failure(new InvalidProviderOutputError({ message: "Invalid JSON input for tool call" }))),
    ).toMatchObject({ code: "A11", action: "retry", maxRetries: 1 })
  })

  test("WebSocket idle 30 minutes is a transport retry, not silence", () => {
    expect(
      classifyError(
        failure(
          new TransportError({
            message: "idle timeout",
            transport: "websocket",
            operation: "read",
            code: "idle-timeout",
          }),
        ),
      ),
    ).toMatchObject({ code: "B3", action: "retry", maxRetries: 1 })
  })

  test("content policy and context overflow never hide behind another model", () => {
    expect(classifyError(failure(new ContentPolicyError({ message: "blocked" })))).toMatchObject({
      code: "A13",
      action: "fail-fast",
    })
    expect(
      classifyError(
        failure(
          new InvalidRequestError({
            message: "maximum context length is 128000 tokens",
            classification: "context-overflow",
          }),
        ),
      ),
    ).toMatchObject({ code: "A12", action: "escalate", maxRetries: 0 })
  })

  test("unknown provider failures retry once at most, then escalate", () => {
    expect(classifyError(failure(new UnknownProviderError({ message: "weird shape" })))).toMatchObject({
      code: "A19",
      action: "retry",
      maxRetries: 1,
    })
  })

  test("MCP, config, git and server-startup failures each get their family", () => {
    expect(classifyError(new Error("MCP server did not start in time"))).toMatchObject({
      code: "C6",
      family: "mcp",
    })
    expect(classifyError(new Error("Unexpected token in config file"))).toMatchObject({
      code: "D1",
      family: "config",
    })
    expect(classifyError(new Error("fatal: not a git repository"))).toMatchObject({
      code: "E2",
      family: "git",
    })
    expect(classifyError(new Error("listen EADDRINUSE: address already in use"))).toMatchObject({
      code: "F1",
      family: "server",
    })
    expect(classifyError(new Error("server failed to start: database is locked"))).toMatchObject({
      family: "database",
    })
    expect(classifyError(new Error("Session not found: ses_123"))).toMatchObject({
      code: "I1",
      family: "session",
    })
  })

  test("an unclassified error lands on J15 and escalates", () => {
    expect(classifyError(new Error("something nobody has seen before"))).toMatchObject({
      code: "J15",
      action: "escalate",
      maxRetries: 1,
    })
    expect(classifyError("just a string")).toMatchObject({ code: "J15" })
  })

  test("main-session fallbacks are only the working Anymodel models", () => {
    expect(MAIN_SESSION_FALLBACK_MODELS).toEqual(["anymodel/sonnet-5", "anymodel/anymodel-coder", "anymodel/gemini-3.8-flash"])
    expect(MAIN_SESSION_FALLBACK_MODELS).not.toContain("anymodel/anymodel-v4.1-flash")
  })
})

describe("SessionEscalate.ladder", () => {
  const cause = failure(new RateLimitError({ message: "Too many requests" }))

  test("an error with retries left stays with the orchestrator", () => {
    expect(ladder({ cause, limitsExhausted: false }).target).toBe("orchestrator")
  })

  test("exhausted limits climb to the society when one exists", () => {
    expect(ladder({ cause, limitsExhausted: true, hasSociety: true }).target).toBe("society")
  })

  test("exhausted limits climb to the president when there is no society", () => {
    expect(ladder({ cause, limitsExhausted: true, hasPresident: true }).target).toBe("president")
  })

  test("exhausted limits with nobody above stay a durable orchestrator failure", () => {
    const escalation = ladder({ cause, limitsExhausted: true })
    expect(escalation.target).toBe("orchestrator")
    expect(escalation.entry.code).toBe("A1")
    expect(escalation.reason.length).toBeGreaterThan(0)
  })
})
