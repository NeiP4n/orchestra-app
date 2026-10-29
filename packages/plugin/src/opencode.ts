/**
 * Connector for OpenCode (v1) plugins.
 *
 * An OpenCode plugin is `(input) => Promise<Hooks>`. `fromOpenCode` runs such plugins unmodified
 * and maps the hooks Orchestra can honour onto the plugin context:
 *
 * - `auth`: OAuth methods become integration methods, and `loader` becomes an SDK options hook,
 *   so a plugin's custom `fetch` and `apiKey` reach the provider exactly as they do in OpenCode.
 * - `tool`: tools are registered with a JSON schema derived from the plugin's zod arguments.
 * - `event`: every Orchestra event is forwarded as `{ type, properties }`.
 *
 * Other hooks (chat.*, permission.ask, ...) have no Orchestra counterpart yet and are ignored.
 */
export * as OpenCode from "./opencode.js"

import { Credential } from "@orchestra/schema/credential"
import type { Form } from "@orchestra/schema/form"
import { Integration } from "@orchestra/schema/integration"
import { z } from "zod"
import type { Context, Plugin as OrchestraPlugin } from "./promise/plugin.js"
import { define } from "./promise/plugin.js"
import type { IntegrationOAuthAuthorization } from "./promise/integration.js"
import type { Registration } from "./promise/registration.js"

export type Auth =
  | { type: "oauth"; refresh: string; access: string; expires: number; accountId?: string; enterpriseUrl?: string }
  | { type: "api"; key: string }
  | { type: "none" }

export type AuthPrompt =
  | {
      type: "text"
      key: string
      message: string
      placeholder?: string
      condition?: (inputs: Record<string, string>) => boolean
    }
  | {
      type: "select"
      key: string
      message: string
      options: ReadonlyArray<{ label: string; value: string; hint?: string }>
      condition?: (inputs: Record<string, string>) => boolean
    }

export type OAuthResult =
  | { type: "success"; refresh: string; access: string; expires: number; accountId?: string; enterpriseUrl?: string }
  | { type: "success"; key: string }
  | { type: "failed" }

export type OAuthAuthorization =
  | { url: string; instructions: string; method: "auto"; callback: () => Promise<OAuthResult> }
  | { url: string; instructions: string; method: "code"; callback: (code: string) => Promise<OAuthResult> }

export type AuthMethod =
  | {
      type: "oauth"
      label: string
      prompts?: ReadonlyArray<AuthPrompt>
      authorize: (inputs?: Record<string, string>) => Promise<OAuthAuthorization>
    }
  | { type: "api"; label: string; prompts?: ReadonlyArray<AuthPrompt> }

export interface LoaderResult {
  apiKey?: string
  baseURL?: string
  fetch?: (input: URL | string | Request, init?: RequestInit) => Promise<Response>
  [key: string]: unknown
}

export interface ToolDefinition {
  description: string
  args: Record<string, z.ZodType>
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
}

export interface ToolContext {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  ask: () => Promise<void>
}

export interface Hooks {
  event?: (input: { event: { type: string; properties: unknown } }) => Promise<void>
  auth?: {
    provider: string
    loader?: (auth: () => Promise<Auth>, provider: unknown) => Promise<LoaderResult>
    methods: ReadonlyArray<AuthMethod>
  }
  tool?: Record<string, ToolDefinition>
  [hook: string]: unknown
}

export interface PluginInput {
  client: unknown
  project: unknown
  directory: string
  worktree: string
  serverUrl: URL
  $: unknown
}

export type OpenCodePlugin = (input: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>

const METHOD_PREFIX = "opencode"
// Core refreshes a credential five minutes before it expires. The plugin's own fetch renews the real
// token, so the stored credential is only a placeholder that keeps core from giving up on it.
const PLACEHOLDER_LIFETIME_MS = 6 * 60_000
const MAX_EXPIRY = 8_640_000_000_000_000

export interface Source {
  readonly id: string
  readonly plugins: ReadonlyArray<OpenCodePlugin>
}

/**
 * Finds OpenCode plugins in a loaded module: `export default fn`, `export default { server: fn }`,
 * or any number of named function exports. Returns `undefined` when the module has none.
 */
export function detect(module: Record<string, unknown>): ReadonlyArray<OpenCodePlugin> | undefined {
  const value = module.default
  if (typeof value === "function") return [value as OpenCodePlugin]
  if (typeof value === "object" && value !== null && "server" in value && typeof value.server === "function")
    return [value.server as OpenCodePlugin]
  // A default object is some other kind of definition, not a bag of plugin functions.
  if (value !== undefined) return undefined
  const named = [
    ...new Set(Object.entries(module).flatMap(([name, item]) => (name !== "default" && typeof item === "function" ? [item] : []))),
  ]
  return named.length ? (named as OpenCodePlugin[]) : undefined
}

export function fromOpenCode(source: Source): OrchestraPlugin {
  return define({
    id: source.id,
    async setup(ctx) {
      const connector = createConnector(ctx, source.id)
      const hooks = []
      for (const plugin of source.plugins) hooks.push(await plugin(connector.input, ctx.options))
      await connector.register(hooks)
      return connector.dispose
    },
  })
}

function createConnector(ctx: Context, pluginID: string) {
  const registrations: Registration[] = []
  const lifetime = new AbortController()
  const overlays = new Map<string, Auth>()
  let disposed = false

  const input: PluginInput = {
    client: createClient(),
    project: { id: ctx.location.project.id, worktree: ctx.location.directory },
    directory: ctx.location.directory,
    worktree: ctx.location.directory,
    serverUrl: new URL(process.env.ORCHESTRA_SERVER_URL ?? "http://127.0.0.1:4096"),
    $: shell(),
  }

  const dispose = async () => {
    if (disposed) return
    disposed = true
    lifetime.abort()
    await Promise.allSettled(registrations.splice(0).reverse().map((registration) => registration.dispose()))
  }

  const register = async (all: ReadonlyArray<Hooks>) => {
    try {
      for (const hooks of all) {
        if (hooks.auth) await registerAuth(hooks.auth)
        if (hooks.tool) registrations.push(await registerTools(hooks.tool))
        if (hooks.event) forwardEvents(hooks.event)
      }
    } catch (error) {
      await dispose()
      throw error
    }
  }

  // --- auth -----------------------------------------------------------------------------------

  const storageKey = (connectionKey: string) => `${METHOD_PREFIX}:${pluginID}:${connectionKey}`

  /** The active connection of a provider, with the plugin's newest copy of its credentials. */
  async function currentAuth(providerID: string): Promise<{ auth: Auth; key: string }> {
    const connection = await ctx.integration.connection.active(providerID)
    if (!connection) return { auth: { type: "none" }, key: "none" }
    const key = connection.type === "credential" ? connection.id : "pool"
    const value = await ctx.integration.connection.resolve(connection)
    if (value?.type === "key") return { auth: { type: "api", key: value.key }, key }
    if (value?.type !== "oauth") return { auth: { type: "none" }, key }
    const stored = await readOverlay(storageKey(key))
    const base: Auth = {
      type: "oauth",
      refresh: value.refresh,
      access: value.access,
      expires: value.expires,
      ...(typeof value.metadata?.accountId === "string" ? { accountId: value.metadata.accountId } : {}),
      ...(typeof value.metadata?.enterpriseUrl === "string" ? { enterpriseUrl: value.metadata.enterpriseUrl } : {}),
    }
    // The plugin renews tokens inside its own fetch, so its copy is the truth while it is newer.
    return { auth: stored && stored.type === "oauth" && stored.expires >= value.expires ? stored : base, key }
  }

  async function readOverlay(key: string): Promise<Auth | undefined> {
    const cached = overlays.get(key)
    if (cached) return cached
    const stored = await ctx.storage.get(key)
    if (!isAuth(stored)) return undefined
    overlays.set(key, stored)
    return stored
  }

  async function writeOverlay(key: string, auth: Auth) {
    overlays.set(key, auth)
    await ctx.storage.set(key, auth)
  }

  async function registerAuth(auth: NonNullable<Hooks["auth"]>) {
    const providerID = auth.provider
    const oauthMethods = auth.methods.flatMap((method, index) => (method.type === "oauth" ? [{ method, index }] : []))
    const methodID = (index: number) => Integration.MethodID.make(`${METHOD_PREFIX}-${index}`)

    if (oauthMethods.length) {
      registrations.push(
        await ctx.integration.transform((editor) => {
          for (const { method, index } of oauthMethods) {
            const form = toForm(method.prompts)
            editor.method.update({
              integrationID: providerID,
              method: { id: methodID(index), type: "oauth", label: method.label, ...(form ? { form } : {}) },
              authorize: async (answer) => {
                const pending = await method.authorize(toInputs(answer))
                return authorization(pending, methodID(index))
              },
              // A refresh never reaches the identity provider from here: the plugin's fetch does that
              // and reports the result through `client.auth.set`. See `PLACEHOLDER_LIFETIME_MS`.
              refresh: async (credential) => {
                const { key } = await currentAuth(providerID).catch(() => ({ key: "pool" }))
                const stored = await readOverlay(storageKey(key))
                if (stored?.type === "oauth") {
                  return { ...credential, refresh: stored.refresh, access: stored.access, expires: Math.max(stored.expires, Date.now() + PLACEHOLDER_LIFETIME_MS) }
                }
                if (credential.expires > Date.now() + PLACEHOLDER_LIFETIME_MS) return credential
                await writeOverlay(storageKey(key), {
                  type: "oauth",
                  refresh: credential.refresh,
                  access: credential.access,
                  expires: credential.expires,
                })
                return { ...credential, expires: Date.now() + PLACEHOLDER_LIFETIME_MS }
              },
              label: (credential) =>
                typeof credential.metadata?.email === "string" ? credential.metadata.email : undefined,
            })
          }
        }),
      )
    }

    if (!auth.loader) return
    const loader = auth.loader
    const providerInfo = { id: providerID, name: providerID, models: {}, options: {} }
    let loaded: { identity: string; result: Promise<LoaderResult> } | undefined
    // The loader runs once per connection; switching accounts re-runs it on the next request.
    const loadFor = async (): Promise<LoaderResult> => {
      const { key } = await currentAuth(providerID)
      if (loaded?.identity === key) return loaded.result
      const result = loader(async () => (await currentAuth(providerID)).auth, providerInfo)
      loaded = { identity: key, result }
      // A failed load must not stick: the next request tries again.
      result.catch(() => {
        if (loaded?.result === result) loaded = undefined
      })
      return result
    }

    registrations.push(
      await ctx.aisdk.hook(
        "options",
        async (event) => {
          const initial = await loadFor().catch(() => ({}) as LoaderResult)
          const { fetch: _fetch, ...settings } = initial
          for (const [name, value] of Object.entries(settings)) if (value !== undefined) event.options[name] = value
          const next = event.options.fetch as Fetch | undefined
          // The SDK is cached, so it must keep working across logins and account switches. Each request
          // asks for the connection's current loader result instead of freezing the first one.
          event.options.fetch = async (request: URL | string | Request, init?: RequestInit) => {
            const result = await loadFor()
            return (result.fetch ?? next ?? fetch)(request, init)
          }
        },
        { providerID },
      ),
    )

    // Refreshed credentials are reported through `client.auth.set`; a new login also needs a new loader.
    const unsubscribe = ctx.event.subscribe({ signal: lifetime.signal })
    void (async () => {
      for await (const event of unsubscribe) {
        if (event.type === "credential.switched" || event.type === "credential.updated") loaded = undefined
      }
    })().catch(() => undefined)

    authSetters.set(providerID, async (value) => {
      const { key } = await currentAuth(providerID)
      await writeOverlay(storageKey(key), value)
    })
  }

  const authSetters = new Map<string, (value: Auth) => Promise<void>>()

  function authorization(pending: OAuthAuthorization, id: Integration.MethodID): IntegrationOAuthAuthorization {
    const finish = async (result: OAuthResult): Promise<Credential.OAuth> => {
      if (result.type === "failed") throw new Error("Authorization failed. Start the login again.")
      if ("key" in result) {
        return Credential.OAuth.make({ type: "oauth", methodID: id, access: result.key, refresh: "", expires: MAX_EXPIRY })
      }
      return Credential.OAuth.make({
        type: "oauth",
        methodID: id,
        access: result.access,
        refresh: result.refresh,
        expires: result.expires,
        ...(result.accountId || result.enterpriseUrl
          ? {
              metadata: {
                ...(result.accountId ? { accountId: result.accountId } : {}),
                ...(result.enterpriseUrl ? { enterpriseUrl: result.enterpriseUrl } : {}),
              },
            }
          : {}),
      })
    }
    if (pending.method === "code") {
      return {
        url: pending.url,
        instructions: pending.instructions,
        mode: "code",
        callback: async (code) => finish(await pending.callback(code)),
      }
    }
    const callback = pending.callback().then(finish)
    // Core awaits this promise right away; a rejection before that must not crash the process.
    callback.catch(() => undefined)
    return { url: pending.url, instructions: pending.instructions, mode: "auto", callback }
  }

  // --- tools ----------------------------------------------------------------------------------

  async function registerTools(tools: NonNullable<Hooks["tool"]>) {
    return ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(tools)) {
        const schema = z.object(definition.args)
        editor.add({
          name,
          description: definition.description,
          input: z.toJSONSchema(schema) as never,
          async execute(args, context) {
            const parsed = schema.parse(args)
            const result = await definition.execute(parsed, {
              sessionID: context.sessionID,
              messageID: context.messageID,
              agent: context.agent,
              directory: ctx.location.directory,
              worktree: ctx.location.directory,
              abort: context.signal,
              metadata: (update) => void context.progress({ ...update.metadata, title: update.title }),
              // Orchestra asks for permission around every tool call; a plugin-initiated ask is a no-op.
              ask: async () => undefined,
            })
            if (typeof result === "string") return { content: result }
            if (typeof result === "object" && result !== null && "output" in result && typeof result.output === "string") {
              return {
                content: result.output,
                ...("metadata" in result && typeof result.metadata === "object" && result.metadata
                  ? { metadata: result.metadata as Record<string, unknown> }
                  : {}),
              }
            }
            return { content: JSON.stringify(result) }
          },
        })
      }
    })
  }

  // --- events ---------------------------------------------------------------------------------

  function forwardEvents(handler: NonNullable<Hooks["event"]>) {
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: lifetime.signal })) {
        // One broken handler must not stop the stream for every later event.
        await handler({ event: { type: event.type, properties: "data" in event ? event.data : {} } }).catch(() => undefined)
      }
    })().catch(() => undefined)
  }

  // --- host objects ---------------------------------------------------------------------------

  function createClient() {
    // The V1 SDK client has no Orchestra equivalent. The calls plugins make for bookkeeping are
    // answered; anything else fails loudly instead of silently doing nothing.
    const unsupported = (path: string) => async () => {
      throw new Error(`OpenCode client call "${path}" is not supported by the Orchestra connector`)
    }
    const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {
      "app.log": async () => ({ data: true }),
      "tui.showToast": async () => ({ data: true }),
      "auth.set": async (request: { path: { id: string }; body: Auth }) => {
        await authSetters.get(request.path.id)?.(request.body)
        return { data: true }
      },
    }
    const branch = (path: string): unknown =>
      new Proxy(() => undefined, {
        get: (_target, name) => (typeof name === "string" ? branch(path ? `${path}.${name}` : name) : undefined),
        apply: (_target, _this, args) => (handlers[path] ?? unsupported(path))(...(args as never[])),
      })
    return branch("")
  }

  return { input, register, dispose }
}

type Fetch = (input: URL | string | Request, init?: RequestInit) => Promise<Response>

function toInputs(answer: Form.Answer): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answer).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value)]),
  )
}

function toForm(prompts: ReadonlyArray<AuthPrompt> | undefined): Form.Fields | undefined {
  if (!prompts?.length) return undefined
  const fields = prompts.map((prompt, index): Form.Field => {
    const when = deriveWhen(prompt, prompts.slice(0, index))
    const base = { key: prompt.key, title: prompt.message, ...(when ? { when } : {}) }
    if (prompt.type === "select") {
      return {
        ...base,
        type: "string",
        required: true,
        options: prompt.options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.hint ? { description: option.hint } : {}),
        })),
      }
    }
    return { ...base, type: "string", ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}) }
  })
  return fields as unknown as Form.Fields
}

/**
 * OpenCode shows a prompt when `condition(inputs)` holds. A form can only compare an earlier answer for
 * equality, so the condition is probed with each option of the preceding selects: when exactly one
 * option enables the prompt, that option becomes the form condition.
 */
function deriveWhen(prompt: AuthPrompt, earlier: ReadonlyArray<AuthPrompt>): Form.When[] | undefined {
  if (!prompt.condition) return undefined
  for (const candidate of earlier) {
    if (candidate.type !== "select") continue
    const enabling = candidate.options.filter((option) => {
      try {
        return prompt.condition?.({ [candidate.key]: option.value }) === true
      } catch {
        return false
      }
    })
    if (enabling.length === 1 && enabling.length < candidate.options.length && enabling[0]) {
      return [{ key: candidate.key, op: "eq", value: enabling[0].value }]
    }
  }
  return undefined
}

function isAuth(value: unknown): value is Auth {
  if (typeof value !== "object" || value === null || !("type" in value)) return false
  if (value.type === "oauth") return "refresh" in value && "access" in value && "expires" in value
  return value.type === "api" || value.type === "none"
}

function shell() {
  const bun = (globalThis as { Bun?: { $: unknown } }).Bun
  if (bun) return bun.$
  return () => {
    throw new Error("The OpenCode shell helper requires Bun")
  }
}
