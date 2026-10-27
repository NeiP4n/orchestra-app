import type { ServerResponse } from "node:http"
import { define } from "@orchestra/plugin/effect/plugin"
import { GeminiCloudCode } from "@orchestra/ai/protocols/gemini-cloudcode"
import { Clock, Deferred, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import { Provider } from "../../provider.js"

export const providerID = Provider.ID.make("google-antigravity")
export const integrationID = Integration.ID.make("google-antigravity")
export const methodID = Integration.MethodID.make("oauth")

const clientID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const clientSecret = "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"
const callbackPort = 51121
const redirectURI = `http://localhost:${callbackPort}/oauth-callback`

const authURL = "https://accounts.google.com/o/oauth2/v2/auth"
const tokenURL = "https://oauth2.googleapis.com/token"
const loadCodeAssistURL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"

const scopes = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ")

export const fallbackProject = "rising-fact-p41fc"

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  token_type: Schema.optional(Schema.String),
})

const LoadCodeAssistResponse = Schema.Struct({
  cloudaicompanionProject: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        id: Schema.optional(Schema.String),
        name: Schema.optional(Schema.String),
      }),
    ]),
  ),
})

export const models: ReadonlyArray<Model.Info> = [
  {
    ...Model.Info.default(providerID, Model.ID.make("gemini-3.1-pro-high")),
    name: "Gemini 3.1 Pro (High)",
    package: "@orchestra/ai/providers/google-antigravity",
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  {
    ...Model.Info.default(providerID, Model.ID.make("gemini-3.1-pro-low")),
    name: "Gemini 3.1 Pro (Low)",
    package: "@orchestra/ai/providers/google-antigravity",
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  {
    ...Model.Info.default(providerID, Model.ID.make("gemini-3-pro-high")),
    name: "Gemini 3 Pro (High)",
    package: "@orchestra/ai/providers/google-antigravity",
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  {
    ...Model.Info.default(providerID, Model.ID.make("gemini-3-pro-low")),
    name: "Gemini 3 Pro (Low)",
    package: "@orchestra/ai/providers/google-antigravity",
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  {
    ...Model.Info.default(providerID, Model.ID.make("gemini-3-flash")),
    name: "Gemini 3 Flash",
    package: "@orchestra/ai/providers/google-antigravity",
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  {
    ...Model.Info.default(providerID, Model.ID.make("claude-sonnet-4-6")),
    name: "Claude Sonnet 4.6",
    package: "@orchestra/ai/providers/google-antigravity",
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 200_000, output: 64_000 },
  },
  {
    ...Model.Info.default(providerID, Model.ID.make("claude-opus-4-6-thinking")),
    name: "Claude Opus 4.6 (Thinking)",
    package: "@orchestra/ai/providers/google-antigravity",
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 200_000, output: 64_000 },
  },
]

function callbackError(params: URLSearchParams, state: string) {
  if (params.get("state") !== state) return "Invalid OAuth state"
  if (params.has("error")) {
    return params.get("error_description") || params.get("error") || "Authorization denied"
  }
  return params.get("code")?.trim() ? undefined : "Missing authorization code"
}

function exchangeCode(http: HttpClient.HttpClient, input: { readonly code: string; readonly verifier: string }) {
  return Effect.gen(function* () {
    const response = yield* http
      .execute(
        HttpClientRequest.post(tokenURL).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "authorization_code",
            client_id: clientID,
            client_secret: clientSecret,
            code: input.code,
            redirect_uri: redirectURI,
            code_verifier: input.verifier,
          }),
        ),
      )
      .pipe(Effect.mapError(() => new Error("Google Antigravity token exchange request failed")))

    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(new Error(`Google Antigravity token exchange failed (${response.status}): ${body}`))
    }

    return yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
      Effect.mapError(() => new Error("Invalid Google token response")),
    )
  })
}

function fetchProjectId(http: HttpClient.HttpClient, accessToken: string) {
  return Effect.gen(function* () {
    const response = yield* http
      .execute(
        HttpClientRequest.post(loadCodeAssistURL).pipe(
          HttpClientRequest.setHeaders({
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity/1.20.4 windows/amd64",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
            "Client-Metadata": JSON.stringify({
              ideType: "ANTIGRAVITY",
              platform: "WINDOWS",
              pluginType: "GEMINI",
            }),
          }),
          HttpClientRequest.bodyJsonUnsafe({
            metadata: { ideType: "ANTIGRAVITY" },
          }),
        ),
      )
      .pipe(Effect.orElseSucceed(() => undefined))

    if (!response || response.status < 200 || response.status >= 300) {
      return fallbackProject
    }

    const parsed = yield* HttpClientResponse.schemaBodyJson(LoadCodeAssistResponse)(response).pipe(
      Effect.orElseSucceed(() => undefined),
    )

    if (!parsed || !parsed.cloudaicompanionProject) {
      return fallbackProject
    }

    if (typeof parsed.cloudaicompanionProject === "string" && parsed.cloudaicompanionProject.length > 0) {
      return parsed.cloudaicompanionProject
    }

    if (typeof parsed.cloudaicompanionProject === "object") {
      const id = parsed.cloudaicompanionProject.id ?? parsed.cloudaicompanionProject.name
      if (typeof id === "string" && id.length > 0) return id
    }

    return fallbackProject
  })
}

function resolveProjectAndMakeCredential(
  http: HttpClient.HttpClient,
  tokens: Schema.Schema.Type<typeof TokenResponse>,
) {
  return Effect.gen(function* () {
    const projectId = yield* fetchProjectId(http, tokens.access_token)
    const now = yield* Clock.currentTimeMillis
    const expires = now + (tokens.expires_in ?? 3600) * 1000
    return Credential.OAuth.make({
      type: "oauth",
      methodID,
      access: tokens.access_token,
      refresh: tokens.refresh_token ?? "",
      expires,
      metadata: {
        projectId,
      },
    })
  })
}

function refresh(http: HttpClient.HttpClient, credential: Credential.OAuth) {
  return Effect.gen(function* () {
    if (!credential.refresh) {
      return yield* Effect.fail(new Error("No refresh token available for Google Antigravity"))
    }
    const response = yield* http
      .execute(
        HttpClientRequest.post(tokenURL).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "refresh_token",
            client_id: clientID,
            client_secret: clientSecret,
            refresh_token: credential.refresh,
          }),
        ),
      )
      .pipe(Effect.mapError(() => new Error("Google Antigravity token refresh request failed")))

    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(new Error(`Google Antigravity token refresh failed (${response.status}): ${body}`))
    }

    const tokens = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
      Effect.mapError(() => new Error("Invalid Google token refresh response")),
    )

    const now = yield* Clock.currentTimeMillis
    const expires = now + (tokens.expires_in ?? 3600) * 1000

    return Credential.OAuth.make({
      type: "oauth",
      methodID: credential.methodID,
      access: tokens.access_token,
      refresh: tokens.refresh_token ?? credential.refresh,
      expires,
      metadata: credential.metadata,
    })
  })
}

export function checkQuota(http: HttpClient.HttpClient, credential: Credential.OAuth) {
  return Effect.gen(function* () {
    const projectId =
      typeof credential.metadata?.projectId === "string" && credential.metadata.projectId.length > 0
        ? credential.metadata.projectId
        : fallbackProject
    const report = yield* GeminiCloudCode.retrieveQuota({
      http,
      accessToken: credential.access,
      projectId,
    })
    GeminiCloudCode.recordQuotaReport(projectId, report)
    return report
  })
}

function authorize(http: HttpClient.HttpClient) {
  return Effect.gen(function* () {
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
    const challenge = Buffer.from(
      yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    ).toString("base64url")
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")

    const callback = yield* Deferred.make<{ code: string; response: ServerResponse }, Error>()
    const { createServer } = yield* Effect.promise(() => import("node:http"))

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost")
      if (request.method !== "GET" || url.pathname !== "/oauth-callback") {
        response.writeHead(404).end()
        return
      }
      const error = callbackError(url.searchParams, state)
      if (error) {
        response
          .writeHead(400, { "Content-Type": "text/html" })
          .end(OauthCallbackPage.error(error, { provider: "Google Antigravity" }))
        Effect.runSync(Deferred.fail(callback, new Error(error)))
        return
      }
      if (!Effect.runSync(Deferred.succeed(callback, { code: url.searchParams.get("code") ?? "", response })))
        response.writeHead(409).end("OAuth callback already received")
    })

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.close()
        server.closeAllConnections()
      }),
    )

    yield* Effect.tryPromise(() =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(callbackPort, () => {
          server.off("error", reject)
          resolve()
        })
      }),
    )

    const params = new URLSearchParams({
      client_id: clientID,
      redirect_uri: redirectURI,
      response_type: "code",
      scope: scopes,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    })

    return {
      mode: "auto" as const,
      url: `${authURL}?${params.toString()}`,
      instructions: "Complete authorization in your browser. This window will close automatically.",
      callback: Effect.gen(function* () {
        const request = yield* Deferred.await(callback)
        const respond = (error?: string) =>
          Effect.sync(() =>
            request.response
              .writeHead(error ? 400 : 200, { "Content-Type": "text/html" })
              .end(
                error
                  ? OauthCallbackPage.error(error, { provider: "Google Antigravity" })
                  : OauthCallbackPage.success({ provider: "Google Antigravity" }),
              ),
          )
        return yield* exchangeCode(http, { code: request.code, verifier }).pipe(
          Effect.flatMap((tokens) => resolveProjectAndMakeCredential(http, tokens)),
          Effect.tap(() => respond()),
          Effect.tapError((error) => respond(error.message)),
          Effect.onInterrupt(() => Effect.sync(() => request.response.destroy())),
        )
      }),
    }
  })
}

export const GoogleAntigravityPlugin = define({
  id: "opencode.provider.google.antigravity",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient

    yield* ctx.integration.transform((editor) => {
      editor.update("google-antigravity", (integration) => {
        integration.name = "Google Antigravity"
      })
      editor.method.update({
        integrationID,
        method: {
          id: methodID,
          type: "oauth",
          label: "Sign in with Google Antigravity",
        },
        authorize: () => authorize(http),
        refresh: (credential) => refresh(http, credential),
      })
    })

    yield* ctx.provider.transform((providers) => {
      if (!providers.get(providerID)) {
        providers.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: "Google Antigravity",
            package: "@orchestra/ai/providers/google-antigravity",
            integrationID,
          },
          models: [...models],
        })
      }
      providers.update(providerID, (provider) => {
        provider.package = "@orchestra/ai/providers/google-antigravity"
        provider.integrationID = integrationID
      })
    })

    // Soft-stop: when Antigravity quota is exhausted, prevent retry storming.
    yield* ctx.session.hook("retry", (event) =>
      Effect.sync(() => {
        if (event.model.providerID !== providerID) return
        const isQuotaErr =
          event.error.type === "provider.quota" ||
          event.error.message.includes("Antigravity quota") ||
          event.error.message.includes("quota exhausted") ||
          event.error.message.includes("RESOURCE_EXHAUSTED")
        if (isQuotaErr) {
          event.decision = { retry: false }
        }
      }),
    )

    // Handle provider 429 response by attempting quota probe to get exact resetTime
    yield* ctx.session.hook("http.response", (event) =>
      Effect.gen(function* () {
        if (event.model.providerID !== providerID) return
        if (event.response.status !== 429 && event.response.status !== 403) return
        const text = yield* Effect.promise(() =>
          event.response
            .clone()
            .text()
            .catch(() => ""),
        )
        if (
          /exhausted/i.test(text) ||
          /resource_exhausted/i.test(text) ||
          /quota/i.test(text)
        ) {
          const connection = yield* ctx.integration.connection.active(integrationID).pipe(Effect.orElseSucceed(() => undefined))
          const stored = connection?.type === "credential" ? connection : undefined
          const credential = stored
            ? yield* ctx.integration.connection.resolve(stored).pipe(Effect.orElseSucceed(() => undefined))
            : undefined
          let resetTime: string | undefined
          if (credential && credential.type === "oauth") {
            const report = yield* checkQuota(http, credential).pipe(Effect.orElseSucceed(() => undefined))
            if (report?.resetTime) {
              resetTime = report.resetTime
            }
          }
          const resetMsg = resetTime ? ` Resets at: ${resetTime}.` : ""
          void event.response.body?.cancel()
          event.response = Response.json(
            {
              error: {
                code: 429,
                status: "RESOURCE_EXHAUSTED",
                message: `Google Antigravity quota exhausted.${resetMsg} Requests paused until quota resets to prevent account suspension.`,
              },
            },
            { status: 429 },
          )
        }
      }),
    )
  }),
})
