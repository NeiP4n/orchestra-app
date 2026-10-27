import type { RouteDefaultsInput } from "../route/client.js"
import { Auth } from "../route/auth.js"
import type { ProviderPackage } from "../provider-package.js"
import { ProviderID, type ModelID } from "../schema/index.js"
import { Gemini } from "../protocols/gemini.js"
import { GeminiCloudCode } from "../protocols/gemini-cloudcode.js"

export type GeminiCloudCodeOptionsInput = GeminiCloudCode.OptionsInput

export const id = ProviderID.make("google-antigravity")

export const routes = [GeminiCloudCode.route]

export type Config = RouteDefaultsInput & {
  readonly accessToken?: string
  readonly apiKey?: string
  readonly auth?: Auth.Definition
  readonly baseURL?: string
  readonly projectId?: string
  readonly project?: string
  readonly providerOptions?: Gemini.ProviderOptionsInput & {
    readonly projectId?: string
    readonly project?: string
  }
}

export type Settings = ProviderPackage.Settings &
  Gemini.ProviderOptionsInput & {
    readonly accessToken?: string
    readonly apiKey?: string
    readonly baseURL?: string
    readonly projectId?: string
    readonly project?: string
  }

const auth = (input: Config) => {
  if (input.auth) return input.auth
  const token = input.accessToken ?? input.apiKey
  return Auth.optional(token, "accessToken")
    .orElse(Auth.config("GOOGLE_ANTIGRAVITY_ACCESS_TOKEN"))
    .orElse(Auth.config("ANTIGRAVITY_ACCESS_TOKEN"))
    .bearer()
}

const configuredRoute = (input: Config) => {
  const {
    accessToken: _accessToken,
    apiKey: _apiKey,
    auth: _auth,
    baseURL,
    headers,
    projectId,
    project,
    providerOptions,
    ...rest
  } = input
  const resolvedProject = projectId ?? project
  return GeminiCloudCode.route.with({
    ...rest,
    endpoint: { baseURL: baseURL ?? GeminiCloudCode.DEFAULT_BASE_URL },
    auth: auth(input),
    headers: headers === undefined ? undefined : { ...headers },
    providerOptions: {
      ...providerOptions,
      ...(resolvedProject !== undefined ? { projectId: resolvedProject } : {}),
    },
  })
}

export const configure = (input: Config = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) =>
      route.model<Gemini.ProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = configure()

export const model: ProviderPackage.Definition<Settings, Gemini.ProviderOptionsInput>["model"] = (
  modelID,
  { accessToken, apiKey, baseURL, body, headers, projectId, project, ...providerOptions },
) =>
  configure({
    accessToken,
    apiKey,
    baseURL,
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    projectId: projectId ?? project,
    providerOptions,
  }).model(modelID)

export * as GoogleAntigravity from "./google-antigravity.js"
