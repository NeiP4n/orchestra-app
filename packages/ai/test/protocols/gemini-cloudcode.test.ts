import { describe, expect } from "bun:test"
import { Effect, Schema, Stream } from "effect"
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
        model: "gemini-3.8-flash",
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
        model: "gemini-3.8-flash",
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
      expect(call.headers.get("user-agent")).toBe("antigravity/1.20.4 windows/amd64")
      expect(call.headers.get("x-goog-api-client")).toBe("google-cloud-sdk vscode_cloudshelleditor/0.1")
      expect(call.headers.get("client-metadata")).toBe(
        '{"ideType":"ANTIGRAVITY","platform":"WINDOWS","pluginType":"GEMINI"}',
      )

      const parsedBody = JSON.parse(call.body)
      expect(parsedBody.project).toBe("test-project-456")
      expect(parsedBody.model).toBe("gemini-3.8-flash")
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
        model: "gemini-3.8-flash",
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
          model: "gemini-3.8-flash",
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
})
