import { Effect, Schema, SchemaTransformation } from "effect"
import { Auth } from "../route/auth.js"
import { Endpoint } from "../route/endpoint.js"
import { Framing } from "../route/framing.js"
import { Protocol } from "../route/protocol.js"
import { Route } from "../route/client.js"
import { Gemini } from "./gemini.js"
import { ProviderShared } from "./shared.js"
import { type LLMRequest, ProviderID } from "../schema/index.js"

const ADAPTER = "gemini-cloudcode"

export const DEFAULT_BASE_URL = "https://daily-cloudcode-pa.googleapis.com"
export const SANDBOX_BASE_URL = "https://daily-cloudcode-pa.sandbox.googleapis.com"
export const STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse"

export const DEFAULT_HEADERS = {
  "User-Agent": "antigravity/1.20.4 windows/amd64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": '{"ideType":"ANTIGRAVITY","platform":"WINDOWS","pluginType":"GEMINI"}',
} as const

export type OptionsInput = Gemini.OptionsInput & {
  readonly projectId?: string
  readonly project?: string
}

export type ProviderOptionsInput = OptionsInput

export const CloudCodeBody = Schema.Struct({
  project: Schema.String,
  model: Schema.String,
  request: Gemini.protocol.body.schema,
  userAgent: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  requestType: Schema.optional(Schema.String),
})
export type CloudCodeBody = Schema.Schema.Type<typeof CloudCodeBody>

export const CloudCodeEvent = Schema.fromJsonString(Schema.Unknown).pipe(
  Schema.decodeTo(
    Gemini.protocol.stream.event,
    SchemaTransformation.transform({
      decode: (u) => {
        if (typeof u === "object" && u !== null) {
          if ("response" in u && typeof u.response === "object" && u.response !== null) {
            return JSON.stringify(u.response)
          }
          return JSON.stringify(u)
        }
        return JSON.stringify(u)
      },
      encode: (s) => JSON.parse(s),
    }),
  ),
)

const resolveProjectId = (request: LLMRequest) => {
  const options = request.providerOptions
  if (typeof options?.projectId === "string" && options.projectId.length > 0) return options.projectId
  if (typeof options?.project === "string" && options.project.length > 0) return options.project
  return (
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GOOGLE_ANTIGRAVITY_PROJECT ??
    process.env.GCP_PROJECT
  )
}

const fromRequest = Effect.fn("GeminiCloudCode.fromRequest")(function* (request: LLMRequest) {
  const projectId = resolveProjectId(request)
  if (!projectId) {
    return yield* ProviderShared.invalidRequest("Google Antigravity requires a projectId")
  }
  const geminiBody = yield* Gemini.protocol.body.from(request)
  return {
    project: projectId,
    model: String(request.model.id),
    request: geminiBody,
  }
})

export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: CloudCodeBody,
    from: fromRequest,
  },
  sanitizer: "gemini",
  stream: {
    event: CloudCodeEvent,
    initial: Gemini.protocol.stream.initial,
    step: Gemini.protocol.stream.step,
    onHalt: Gemini.protocol.stream.onHalt,
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: ProviderID.make("google-antigravity"),
  providerMetadataKey: "antigravity",
  protocol,
  endpoint: Endpoint.path(STREAM_PATH, {
    baseURL: DEFAULT_BASE_URL,
  }),
  auth: Auth.none,
  framing: Framing.sse,
  headers: () => ({ ...DEFAULT_HEADERS }),
})

export * as GeminiCloudCode from "./gemini-cloudcode.js"
