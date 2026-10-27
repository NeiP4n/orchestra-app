import { describe, expect, test } from "bun:test"
import { Effect, Redacted, Schema, Stream } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import {
  LLM,
  LLMClient,
  LLMEvent,
  Message,
  ToolDefinition,
} from "../../src/index.js"
import { GeminiCloudCode } from "../../src/protocols/gemini-cloudcode.js"
import { GoogleAntigravity } from "../../src/providers/google-antigravity.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, observe, type Call } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

describe("Gemini Cloud Code (Google Antigravity) Protocol", () => {
  const model = GoogleAntigravity.configure({
    accessToken: "test-token-123",
    projectId: "test-project-456",
  }).model("gemini-3.8-flash")

  it.effect("prepares Antigravity request body with wrapped project, model, and request", () =>
    Effect.gen(function* () {
      const request = LLM.request({
        model,
        system: "You are an expert coder.",
        prompt: "Write a hello world program in TypeScript.",
        generation: {
          maxTokens: 500,
          temperature: 0.2,
        },
      })

      const prepared = yield* compileRequest(request)

      expect(prepared.route).toBe("gemini-cloudcode")
      expect(prepared.body).toMatchObject({
        project: "test-project-456",
        model: "gemini-3.8-flash-high",
        request: {
          contents: [
            {
              role: "user",
              parts: [{ text: "Write a hello world program in TypeScript." }],
            },
          ],
          systemInstruction: {
            parts: [{ text: "You are an expert coder." }],
          },
          generationConfig: {
            maxOutputTokens: 500,
            temperature: 0.2,
          },
        },
      })
    }),
  )

  it.effect("includes tools inside the request wrapper", () =>
    Effect.gen(function* () {
      const weatherTool = ToolDefinition.make({
        name: "get_weather",
        description: "Get weather for a given city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
        },
      })

      const request = LLM.request({
        model,
        prompt: "What is the weather in Tokyo?",
        tools: [weatherTool],
      })

      const prepared = yield* compileRequest(request)

      expect(prepared.body).toMatchObject({
        project: "test-project-456",
        model: "gemini-3.8-flash-high",
        request: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: "get_weather",
                  description: "Get weather for a given city",
                },
              ],
            },
          ],
        },
      })
    }),
  )

  it.effect("fails with typed AIError when projectId is missing", () =>
    Effect.gen(function* () {
      const modelWithoutProject = GoogleAntigravity.configure({
        accessToken: "test-token",
      }).model("gemini-3.8-flash")

      const request = LLM.request({
        model: modelWithoutProject,
        prompt: "Hello without project",
      })

      const error = yield* compileRequest(request).pipe(Effect.flip)
      expect(error.message).toContain("Google Antigravity requires a projectId")
    }),
  )

  it.effect("sends requests to the correct endpoint with proper headers and bearer token", () =>
    Effect.gen(function* () {
      const calls: Call[] = []
      const responseSse = sseEvents(
        {
          response: {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "Hello from Antigravity!" }],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 15,
              candidatesTokenCount: 6,
              totalTokenCount: 21,
            },
          },
          traceId: "trace-abc-123",
        },
        {
          response: {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "" }],
                },
                finishReason: "STOP",
              },
            ],
          },
          traceId: "trace-abc-123",
        },
      )

      const layer = dynamicResponse((input) =>
        Effect.gen(function* () {
          yield* observe(calls, input)
          return input.respond(responseSse, {
            headers: { "content-type": "text/event-stream" },
          })
        }),
      )

      const request = LLM.request({
        model,
        prompt: "Say hello",
      })

      const response = yield* LLMClient.generate(request).pipe(Effect.provide(layer))

      expect(calls.length).toBe(1)
      const call = calls[0]
      expect(call.method).toBe("POST")
      expect(call.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse")
      expect(call.headers.get("authorization")).toBe("Bearer test-token-123")
      expect(call.headers.get("user-agent")).toBe(GeminiCloudCode.ANTIGRAVITY_HUB_USER_AGENT)
      expect(call.headers.get("x-goog-api-client")).toBe("google-cloud-sdk vscode_cloudshelleditor/0.1")
      expect(call.headers.get("client-metadata")).toBe(
        '{"ideType":"ANTIGRAVITY","platform":"WINDOWS","pluginType":"GEMINI"}',
      )

      const parsedBody = JSON.parse(call.body)
      expect(parsedBody.project).toBe("test-project-456")
      expect(parsedBody.model).toBe("gemini-3.8-flash-high")
      expect(parsedBody.request).toBeDefined()
      expect(parsedBody.request.contents[0].parts[0].text).toBe("Say hello")

      expect(response.text).toBe("Hello from Antigravity!")
      expect(response.usage).toMatchObject({
        inputTokens: 15,
        outputTokens: 6,
        totalTokens: 21,
      })
      expect(response.finishReason?.normalized).toBe("stop")
    }),
  )

  it.effect("unpacks streaming thought / reasoning parts without losing signatures", () =>
    Effect.gen(function* () {
      const responseSse = sseEvents(
        {
          response: {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      thought: true,
                      text: "Analyzing TypeScript syntax...",
                      thoughtSignature: "sig-thought-456",
                    },
                  ],
                },
              },
            ],
          },
          traceId: "trace-thought-1",
        },
        {
          response: {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "console.log('Hello');" }],
                },
                finishReason: "STOP",
              },
            ],
          },
          traceId: "trace-thought-1",
        },
      )

      const layer = dynamicResponse((input) =>
        Effect.succeed(
          input.respond(responseSse, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      )

      const request = LLM.request({
        model,
        prompt: "Generate code",
      })

      const events = yield* LLMClient.stream(request).pipe(
        Stream.runCollect,
        Effect.provide(layer),
      )

      const reasoningDeltas = Array.from(events).filter(LLMEvent.is.reasoningDelta)
      expect(reasoningDeltas.length).toBeGreaterThan(0)
      expect(reasoningDeltas[0].text).toBe("Analyzing TypeScript syntax...")
      expect(reasoningDeltas[0].providerMetadata).toMatchObject({
        antigravity: {
          thoughtSignature: "sig-thought-456",
        },
      })

      const textDeltas = Array.from(events).filter(LLMEvent.is.textDelta)
      expect(textDeltas.length).toBeGreaterThan(0)
      expect(textDeltas[0].text).toBe("console.log('Hello');")
    }),
  )

  it.effect("unpacks tool calls without breaking IDs, args or signatures", () =>
    Effect.gen(function* () {
      const weatherTool = ToolDefinition.make({
        name: "get_weather",
        description: "Get weather for a given city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
        },
      })

      const responseSse = sseEvents(
        {
          response: {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      functionCall: {
                        name: "get_weather",
                        args: { city: "Kyoto" },
                        id: "call_kyoto_789",
                      },
                      thoughtSignature: "sig-tool-kyoto",
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          },
          traceId: "trace-tool-1",
        },
      )

      const layer = dynamicResponse((input) =>
        Effect.succeed(
          input.respond(responseSse, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      )

      const request = LLM.request({
        model,
        prompt: "Weather in Kyoto?",
        tools: [weatherTool],
      })

      const events = yield* LLMClient.stream(request).pipe(
        Stream.runCollect,
        Effect.provide(layer),
      )

      const toolCalls = Array.from(events).filter(LLMEvent.is.toolCall)
      expect(toolCalls.length).toBe(1)
      expect(toolCalls[0].name).toBe("get_weather")
      expect(toolCalls[0].id).toBe("call_kyoto_789")
      expect(toolCalls[0].input).toEqual({ city: "Kyoto" })
      expect(toolCalls[0].providerMetadata).toMatchObject({
        antigravity: {
          thoughtSignature: "sig-tool-kyoto",
        },
      })
    }),
  )

  it.effect("handles provider error frames gracefully", () =>
    Effect.gen(function* () {
      const errorSse = sseEvents({
        error: {
          code: 429,
          message: "You have exhausted your capacity on this model.",
          status: "RESOURCE_EXHAUSTED",
        },
      })

      const layer = dynamicResponse((input) =>
        Effect.succeed(
          input.respond(errorSse, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      )

      const request = LLM.request({
        model,
        prompt: "Hello",
      })

      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(layer),
        Effect.flip,
      )

      expect(error.message).toContain("You have exhausted your capacity on this model.")
    }),
  )

  it.effect("supports GoogleAntigravity.model package definition entrypoint", () =>
    Effect.gen(function* () {
      const packageModel = GoogleAntigravity.model("gemini-3.8-flash", {
        accessToken: "direct-token",
        projectId: "direct-project",
        thinkingConfig: {
          thinkingBudget: 1024,
        },
      })

      const request = LLM.request({
        model: packageModel,
        prompt: "Test from package entrypoint",
      })

      const prepared = yield* compileRequest(request)
      expect(prepared.body).toMatchObject({
        project: "direct-project",
        model: "gemini-3.8-flash-high",
        request: {
          generationConfig: {
            thinkingConfig: {
              thinkingBudget: 1024,
            },
          },
        },
      })
    }),
  )

  it.effect("resolves projectId from environment variable when omitted in config", () =>
    Effect.gen(function* () {
      const prev = process.env.GOOGLE_CLOUD_PROJECT
      process.env.GOOGLE_CLOUD_PROJECT = "env-project-789"
      try {
        const envModel = GoogleAntigravity.configure({
          accessToken: "env-token",
        }).model("gemini-3.8-flash")

        const request = LLM.request({
          model: envModel,
          prompt: "Testing env project",
        })

        const prepared = yield* compileRequest(request)
        expect(prepared.body).toMatchObject({
          project: "env-project-789",
          model: "gemini-3.8-flash-high",
        })
      } finally {
        if (prev === undefined) {
          delete process.env.GOOGLE_CLOUD_PROJECT
        } else {
          process.env.GOOGLE_CLOUD_PROJECT = prev
        }
      }
    }),
  )

  it.effect("allows overriding baseURL with sandbox endpoint", () =>
    Effect.gen(function* () {
      const sandboxModel = GoogleAntigravity.configure({
        accessToken: "sandbox-token",
        projectId: "sandbox-proj",
        baseURL: GeminiCloudCode.SANDBOX_BASE_URL,
      }).model("gemini-3.8-flash")

      const calls: Call[] = []
      const layer = dynamicResponse((input) =>
        Effect.gen(function* () {
          yield* observe(calls, input)
          return input.respond(
            sseEvents({
              response: {
                candidates: [
                  {
                    content: { role: "model", parts: [{ text: "From sandbox" }] },
                    finishReason: "STOP",
                  },
                ],
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        }),
      )

      const request = LLM.request({
        model: sandboxModel,
        prompt: "Hello sandbox",
      })

      const response = yield* LLMClient.generate(request).pipe(Effect.provide(layer))
      expect(calls[0].url).toBe("https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse")
      expect(response.text).toBe("From sandbox")
    }),
  )

  // ==========================================
  // Antigravity Quota Retrieval & Parsing Tests
  // ==========================================

  describe("Quota Retrieval & Soft-stop Parsing", () => {
    test("parses retrieveUserQuotaSummary with Gemini and Claude+GPT 5h and weekly windows", () => {
      const rawSummaryFixture = {
        groups: [
          {
            displayName: "Gemini Models",
            description: "Usage for Gemini family models",
            buckets: [
              {
                bucketId: "gemini-5h",
                displayName: "5 Hours",
                window: "18000s",
                remaining: {
                  remainingFraction: 0.75,
                },
                resetTime: "2026-10-27T16:00:00Z",
              },
              {
                bucketId: "gemini-weekly",
                displayName: "Weekly",
                window: "604800s",
                remainingFraction: 0.9,
                resetTime: "2026-11-01T00:00:00Z",
              },
            ],
          },
          {
            displayName: "Claude and GPT models",
            description: "Usage for 3P models",
            buckets: [
              {
                bucketId: "claude-5h",
                displayName: "5 Hours",
                window: "18000s",
                remainingFraction: 0.4,
                resetTime: "2026-10-27T17:30:00Z",
              },
              {
                bucketId: "claude-weekly",
                displayName: "Weekly",
                window: "604800s",
                remainingFraction: 0.85,
                resetTime: "2026-11-01T00:00:00Z",
              },
            ],
          },
        ],
      }

      const report = GeminiCloudCode.parseQuotaSummaryResponse(rawSummaryFixture)

      expect(report.source).toBe("retrieveUserQuotaSummary")
      expect(report.isExhausted).toBe(false)
      expect(report.groups.length).toBe(2)

      const geminiGroup = report.groups.find((g) => g.family === "gemini")!
      expect(geminiGroup).toBeDefined()
      expect(geminiGroup.buckets.length).toBe(2)
      expect(geminiGroup.buckets[0].windowKind).toBe("5h")
      expect(geminiGroup.buckets[0].remainingFraction).toBe(0.75)
      expect(geminiGroup.buckets[0].resetTime).toBe("2026-10-27T16:00:00Z")
      expect(geminiGroup.buckets[1].windowKind).toBe("weekly")
      expect(geminiGroup.buckets[1].remainingFraction).toBe(0.9)

      const claudeGroup = report.groups.find((g) => g.family === "claude-gpt")!
      expect(claudeGroup).toBeDefined()
      expect(claudeGroup.buckets.length).toBe(2)
      expect(claudeGroup.buckets[0].windowKind).toBe("5h")
      expect(claudeGroup.buckets[0].remainingFraction).toBe(0.4)
      expect(claudeGroup.buckets[1].windowKind).toBe("weekly")
      expect(claudeGroup.buckets[1].remainingFraction).toBe(0.85)
    })

    test("detects exhausted quota (remainingFraction === 0) and yields typed error with resetTime", () => {
      const rawExhaustedFixture = {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "gemini-5h",
                displayName: "5 Hours",
                window: "18000s",
                remainingFraction: 0,
                resetTime: "2026-10-27T18:45:00Z",
              },
              {
                bucketId: "gemini-weekly",
                window: "604800s",
                remainingFraction: 0.6,
                resetTime: "2026-11-01T00:00:00Z",
              },
            ],
          },
        ],
      }

      const report = GeminiCloudCode.parseQuotaSummaryResponse(rawExhaustedFixture)
      expect(report.isExhausted).toBe(true)
      expect(report.resetTime).toBe("2026-10-27T18:45:00Z")
      expect(report.exhaustedBucket?.windowKind).toBe("5h")

      const checkExit = Effect.runSyncExit(GeminiCloudCode.assertQuotaAvailable(report))
      expect(checkExit._tag).toBe("Failure")
      if (checkExit._tag === "Failure") {
        const error = checkExit.cause
        const errorStr = JSON.stringify(error)
        expect(errorStr).toContain("AntigravityQuotaExceeded")
        expect(errorStr).toContain("2026-10-27T18:45:00Z")
        expect(errorStr).toContain("5-hour window")
      }
    })

    it.effect("executes retrieveQuota with bearer token without leaking token in logs", () =>
      Effect.gen(function* () {
        const secretToken = "super-secret-oauth-token-xyz-999"
        const calls: { url: string; headers: Record<string, string>; body: unknown }[] = []

        const mockHttp = HttpClient.make((request) =>
          Effect.gen(function* () {
            const authHeader = request.headers.authorization ?? ""
            const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
            const text = yield* Effect.promise(() => web.text())
            calls.push({
              url: request.url,
              headers: { ...request.headers },
              body: text ? JSON.parse(text) : undefined,
            })

            expect(authHeader).toBe(`Bearer ${secretToken}`)

            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  groups: [
                    {
                      displayName: "Gemini Models",
                      buckets: [
                        {
                          bucketId: "gemini-5h",
                          window: "18000s",
                          remainingFraction: 1.0,
                          resetTime: "2026-10-27T20:00:00Z",
                        },
                      ],
                    },
                  ],
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                },
              ),
            )
          }),
        )

        const report = yield* GeminiCloudCode.retrieveQuota({
          http: mockHttp,
          accessToken: Redacted.make(secretToken),
          projectId: "my-cloud-project-123",
        })

        expect(calls.length).toBe(1)
        expect(calls[0].url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary")
        expect(calls[0].body).toEqual({ project: "my-cloud-project-123" })
        expect(report.source).toBe("retrieveUserQuotaSummary")
        expect(report.groups.length).toBe(1)
        expect(report.groups[0].buckets[0].remainingFraction).toBe(1.0)
      }),
    )

    it.effect("falls back to fetchAvailableModels when retrieveUserQuotaSummary returns non-2xx", () =>
      Effect.gen(function* () {
        const secretToken = "fallback-secret-token-456"
        const requestedUrls: string[] = []

        const mockHttp = HttpClient.make((request) =>
          Effect.gen(function* () {
            requestedUrls.push(request.url)

            if (request.url.includes("retrieveUserQuotaSummary")) {
              return HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify({ error: "Not found or disabled" }), {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                }),
              )
            }

            if (request.url.includes("fetchAvailableModels")) {
              return HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    models: {
                      "gemini-3.8-flash": {
                        displayName: "Gemini 3.8 Flash",
                        quotaInfo: {
                          remainingFraction: 0.5,
                          resetTime: "2026-10-27T21:00:00Z",
                        },
                      },
                      "claude-sonnet-4-6": {
                        displayName: "Claude Sonnet 4.6",
                        quotaInfo: {
                          remainingFraction: 0.2,
                          resetTime: "2026-10-27T22:00:00Z",
                        },
                      },
                    },
                  }),
                  {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                  },
                ),
              )
            }

            return HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 }))
          }),
        )

        const report = yield* GeminiCloudCode.retrieveQuota({
          http: mockHttp,
          accessToken: Redacted.make(secretToken),
          projectId: "fallback-project",
        })

        expect(requestedUrls.length).toBe(2)
        expect(requestedUrls[0]).toContain("retrieveUserQuotaSummary")
        expect(requestedUrls[1]).toContain("fetchAvailableModels")

        expect(report.source).toBe("fetchAvailableModels")
        expect(report.groups.length).toBe(2)
        const geminiGroup = report.groups.find((g) => g.family === "gemini")!
        expect(geminiGroup.buckets[0].remainingFraction).toBe(0.5)
        const claudeGroup = report.groups.find((g) => g.family === "claude-gpt")!
        expect(claudeGroup.buckets[0].remainingFraction).toBe(0.2)
      }),
    )

    it.effect("never leaks token in error when both endpoints fail", () =>
      Effect.gen(function* () {
        const sensitiveToken = "super-confidential-token-9999"

        const failingHttp = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("Server Error", { status: 500 }),
            ),
          ),
        )

        const error = yield* GeminiCloudCode.retrieveQuota({
          http: failingHttp,
          accessToken: Redacted.make(sensitiveToken),
          projectId: "test-project",
        }).pipe(Effect.flip)

        const errorString = JSON.stringify(error)
        expect(errorString).not.toContain(sensitiveToken)
        expect(error.message).toContain("Failed to retrieve Antigravity quota")
      }),
    )

    it.effect("soft-stops: refuses to compile/send request when quota for project is cached as exhausted", () =>
      Effect.gen(function* () {
        const futureResetTime = new Date(Date.now() + 3600_000).toISOString()
        GeminiCloudCode.clearQuotaCache("proj-exhausted")
        GeminiCloudCode.recordQuotaReport("proj-exhausted", {
          groups: [],
          isExhausted: true,
          resetTime: futureResetTime,
          exhaustedBucket: {
            bucketId: "gemini-5h",
            window: "18000s",
            windowKind: "5h",
            remainingFraction: 0,
            resetTime: futureResetTime,
          },
          source: "retrieveUserQuotaSummary",
        })

        const exhaustedModel = GoogleAntigravity.configure({
          accessToken: "valid-token",
          projectId: "proj-exhausted",
        }).model("gemini-3.8-flash")

        const request = LLM.request({
          model: exhaustedModel,
          prompt: "Should not be sent",
        })

        const error = yield* compileRequest(request).pipe(Effect.flip)
        expect(error._tag).toBe("AI.Error")
        expect(error.reason._tag).toBe("QuotaExceeded")
        expect(error.message).toContain("Google Antigravity quota is exhausted (5-hour window)")
        expect(error.message).toContain(futureResetTime)
        expect(error.message).toContain("Requests paused until quota resets")
      }),
    )
  })
})
