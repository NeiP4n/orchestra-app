export * as SessionModelRequest from "./model-request.js"

import {
  GenerationOptions,
  type GenerationOptionsFields,
  HttpOptions,
  LanguageModel,
  LLM,
  LLMRequest,
  type Media,
  Message,
  SystemPart,
} from "@orchestra/ai"
import type { StreamOptions } from "@orchestra/ai/route"
import type {
  SessionCompaction,
  SessionContext,
  SessionGenerate,
  SessionRequest,
  SessionRequestKind,
  SessionTitle,
} from "@orchestra/plugin/effect/session"
import type { Agent } from "@orchestra/schema/agent"
import type { Model } from "@orchestra/schema/model"
import { Mode } from "@orchestra/schema/mode"
import type { Content } from "@orchestra/schema/tool"
import { Cause, Context, Effect, Layer, Result, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { App } from "../app.js"
import { Permission } from "../permission.js"
import { PluginHooks } from "../plugin/hooks.js"
import { zenRequiredToolNames } from "../provider-request-compatibility.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { Tool } from "../tool.js"
import { ToolRouter } from "../tool/router.js"
import { SessionAffinity } from "./affinity.js"
import { SessionModelTransport } from "./model-transport.js"
import { SessionPrefixPin } from "./prefix-pin.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionRequestReport } from "./request-report.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionSystemPrompt } from "./system-prompt.js"
import { toLLMMessages } from "./runner/to-llm-message.js"
import type { SessionMessage } from "./message.js"

const IMAGE_BYTES_TRIGGER = 25 * 1024 * 1024 // 25 MiB
const IMAGE_BYTES_TARGET = 15 * 1024 * 1024 // 15 MiB
const IMAGE_REMOVED =
  "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]"
const GENERATION_KEYS = new Set(Object.keys(GenerationOptions.fields))
// Used when the catalog has no output limit for the model.
const OUTPUT_TOKEN_FALLBACK = 32_000
// No reply needs more, however much the model allows.
const OUTPUT_TOKEN_MAX = 256_000
// A summary never needs more, and a request asking for more cannot be shrunk to fit a window the catalog overstates.
const SUMMARY_OUTPUT_MAX = 32_000
// Prompt text is estimated at about 4 characters per token, which can run low on dense text such as code.
const ESTIMATE_ERROR = 0.15
// Never ask for less; only reachable with automatic compaction off, since it keeps the window from filling this far.
const OUTPUT_TOKEN_MIN = 1_024

/** Tool errors, plus the user declining a permission or dismissing a question. */
export type ExecuteError = Tool.Error | Permission.DeclinedError | QuestionTool.CancelledError

export interface Prepared<Event = SessionRequest> {
  readonly event: Event
  readonly request: LLMRequest
  readonly options: StreamOptions
  readonly retry: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  /** Runs a tool call against the tools this request advertised. */
  readonly executeTool: (
    input: Parameters<Tool.Snapshot["execute"]>[0],
  ) => Effect.Effect<Tool.NormalizedResult, ExecuteError>
}

export interface Input {
  readonly session: SessionSchema.Info
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly tools?: Tool.Snapshot
  readonly system: Array<SystemPart>
  readonly messages: Array<Message>
  readonly toolChoice?: LLM.RequestInput["toolChoice"]
  /** Only the durable runner may use a stateful WebSocket. */
  readonly webSocket?: "session"
  /** Prompt size, measured by the provider or estimated. The default output limit leaves room for it. */
  readonly inputTokens?: { readonly measured: number; readonly estimated: number }
}

/** The default output limit: the catalog limit, fitted to the room the prompt leaves in the context window. */
const outputLimit = (
  limit: Model.Info["limit"],
  kind: "primary" | "compaction",
  inputTokens?: Input["inputTokens"],
) => {
  const model = Math.min(limit.output > 0 ? limit.output : OUTPUT_TOKEN_FALLBACK, OUTPUT_TOKEN_MAX)
  const requested = kind === "compaction" ? Math.min(model, SUMMARY_OUTPUT_MAX) : model
  if (inputTokens === undefined || limit.context <= 0) return requested
  const room = limit.context - inputTokens.measured - Math.ceil(inputTokens.estimated * (1 + ESTIMATE_ERROR))
  return Math.min(requested, Math.max(OUTPUT_TOKEN_MIN, room))
}

export const baseTranscript = (input: {
  readonly agent: Agent.Info
  readonly model: SessionRunnerModel.Resolved
  readonly tools: Tool.Snapshot
  readonly initial: string
  readonly messages: ReadonlyArray<SessionMessage.Info>
}) => {
  const providerMetadataKey = input.model.model.route.providerMetadataKey ?? input.model.model.provider
  return {
    providerMetadataKey,
    system: [
      input.agent.system
        ? input.agent.system
        : SessionSystemPrompt.make(input.tools.definitions.map((tool) => tool.name)),
      input.initial,
    ]
      .filter((part) => part.length > 0)
      .map(SystemPart.make),
    messages: toLLMMessages(input.messages, input.model.ref, providerMetadataKey),
  }
}

const mimeToModality = (mime: string) => {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
}

// xAI rejects any other image type (e.g. GIF) with invalid_image, and the stored image would fail every later turn.
const XAI_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"])

const unsupportedMedia = (
  mime: string,
  name: string | undefined,
  capabilities: Model.Capabilities,
  provider: string | undefined,
) => {
  const modality = mimeToModality(mime)
  if (!modality) return
  const unsupported = !capabilities.input.some((item) => item.startsWith(modality))
    ? modality
    : provider === "xai" && modality === "image" && !XAI_IMAGE_MIMES.has(mime.toLowerCase())
      ? mime
      : undefined
  if (!unsupported) return
  return `ERROR: Cannot read ${name ? `"${name}"` : modality} (this model does not support ${unsupported} input). Inform the user.`
}

// Remote and provider-referenced media carry no local payload and never count toward the inline budget.
const mediaBytes = (media: Media.Asset) => {
  if (media.source.type === "base64") return Buffer.byteLength(media.source.data)
  if (media.source.type === "bytes") return Math.ceil(media.source.data.byteLength / 3) * 4
  return 0
}

/** Replaces media with the returned text; messages without replacements are returned unchanged. */
const replaceMedia = (
  messages: LLMRequest["messages"],
  replace: (media: { mime: string; name: string | undefined; bytes: () => number }) => string | undefined,
) =>
  messages.map((message) => {
    const content = message.content.map((part) => {
      if (part.type === "media") {
        const text = replace({ mime: part.media.mediaType, name: part.filename, bytes: () => mediaBytes(part.media) })
        return text === undefined ? part : Message.text(text)
      }
      if (part.type !== "tool-result" || part.result.type !== "content") return part
      const result = part.result
      const value = result.value.map((item): Content => {
        if (item.type !== "file") return item
        const text = replace({ mime: item.mime, name: item.name, bytes: () => Buffer.byteLength(item.uri) })
        return text === undefined ? item : { type: "text", text }
      })
      return value.every((item, index) => item === result.value[index])
        ? part
        : { ...part, result: { ...result, value } }
    })
    return content.every((part, index) => part === message.content[index])
      ? message
      : new Message({ ...message, content })
  })

export const unsupportedParts = (
  messages: LLMRequest["messages"],
  capabilities: Model.Capabilities,
  provider?: string,
) => replaceMedia(messages, (media) => unsupportedMedia(media.mime, media.name, capabilities, provider))

export const boundImages = (messages: LLMRequest["messages"]) => {
  const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")
  const imageBytes = messages.reduce(
    (total, message) =>
      total +
      message.content.reduce((sum, part) => {
        if (part.type === "media" && isImage(part.media.mediaType)) return sum + mediaBytes(part.media)
        if (part.type !== "tool-result" || part.result.type !== "content") return sum
        return (
          sum +
          part.result.value.reduce(
            (bytes: number, item: Content) =>
              bytes + (item.type === "file" && isImage(item.mime) ? Buffer.byteLength(item.uri) : 0),
            0,
          )
        )
      }, 0),
    0,
  )
  if (imageBytes <= IMAGE_BYTES_TRIGGER) return messages

  let removed = 0
  return replaceMedia(messages, (media) => {
    if (!isImage(media.mime) || imageBytes - removed <= IMAGE_BYTES_TARGET) return
    removed += media.bytes()
    return IMAGE_REMOVED
  })
}

type Definitions = PluginHooks.Domains["session"]["context"]["tools"]

/** Builds the model request for each session flow. Each entry runs its own plugin hook. */
export interface Interface {
  readonly primary: (input: Input) => Effect.Effect<Prepared<SessionContext>>
  readonly compaction: (input: Input) => Effect.Effect<Prepared<SessionCompaction>>
  readonly generate: (input: Input) => Effect.Effect<Prepared<SessionGenerate>>
  readonly title: (input: Input) => Effect.Effect<Prepared<SessionTitle>>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/SessionModelRequest") {}

const ZEN_TOOL_LIMIT = 128
const ZEN_REQUIRED_TOOLS = new Set<string>(zenRequiredToolNames)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const transport = yield* SessionModelTransport.Service
    const app = yield* App.Metadata
    const pin = SessionPrefixPin.make()
    const prepare = Effect.fn("SessionModelRequest.prepare")(function* <
      S extends SessionRequest & { tools?: Definitions },
    >(kind: SessionRequestKind, input: Input, shape: (draft: SessionRequest, tools: Definitions) => Effect.Effect<S>) {
      const session = input.session
      const model = input.model
      const scope = { sessionID: session.id, agent: input.agent, model: model.ref, kind }
      const tools: Tool.Snapshot = input.tools ?? {
        definitions: [],
        execute: () => new Tool.Error({ message: "Tools are not available for this request" }),
      }
      // OpenCode Zen's free-tier validator rejects requests when a permission rule removes
      // built-in read/bash from the advertised tool list. Keep their schemas in the request for
      // the built-in OpenCode provider, while Tool.snapshot.execute still enforces local policy.
      // This does not grant permission to execute either tool: hidden tools are not present in the
      // snapshot's active executor maps.
      const deniedCompatibility =
        model.ref.providerID === "opencode" ? (tools.compatibilityDefinitions ?? []) : []
      // On-demand direct tools join the request once the session loaded or called them, or the
      // user's words triggered them. The rest stay one line each in the `tools` index.
      const picked = new Set([
        ...ToolRouter.selected(input.messages, tools.lazy ?? new Map()),
        ...Mode.toolsOf(session.metadata, input.agent),
      ])
      const loaded = (tools.lazyDefinitions ?? []).filter((tool) => picked.has(tool.name))
      // Zen's upstream rejects more than 128 tools. Mirrored CodeMode schemas are only a validator
      // courtesy (every one stays callable through `execute`), and mirroring a whole browser or MCP
      // catalog cost ~9k prompt tokens per step, so only the tools Zen's validator looks for are
      // mirrored. ORCHESTRA_ZEN_MIRROR=all restores the full mirror.
      const mirrorAll = process.env.ORCHESTRA_ZEN_MIRROR === "all"
      const zenCompatibility =
        model.ref.providerID === "opencode"
          ? [...(tools.codeModeDefinitions ?? []), ...deniedCompatibility]
              .filter((candidate) => mirrorAll || ZEN_REQUIRED_TOOLS.has(candidate.name))
              .filter(
                (candidate, index, all) =>
                  !tools.definitions.some((tool) => tool.name === candidate.name) &&
                  all.findIndex((other) => other.name === candidate.name) === index,
              )
              .sort(
                (left, right) =>
                  Number(!ZEN_REQUIRED_TOOLS.has(left.name)) - Number(!ZEN_REQUIRED_TOOLS.has(right.name)),
              )
              .slice(0, Math.max(0, ZEN_TOOL_LIMIT - tools.definitions.length - loaded.length))
          : []
      const advertised = [...tools.definitions, ...loaded, ...zenCompatibility]
      // Remember which tool each definition object came from. Hooks rename a tool by moving
      // its definition to a new key, so after the hook we find the tool by object identity.
      const given = new Map(
        advertised.map((t) => [{ description: t.description, input: { ...t.inputSchema } }, t] as const),
      )
      // Hooks see the default output limit and may change or remove it. Titles and generate keep the provider default,
      // because their reasoning is hard to budget.
      const shaped = yield* shape(
        {
          sessionID: session.id,
          model: model.ref,
          system: input.system,
          messages: input.messages,
          options:
            kind === "primary" || kind === "compaction"
              ? { maxTokens: outputLimit(model.limit, kind, input.inputTokens) }
              : {},
        },
        Object.fromEntries(Array.from(given, ([d, t]) => [t.name, d])),
      )
      // Match by identity first, then by key. Entries matching neither were invented by a
      // hook and are dropped. `t.name` stays the real name so execution can map renames back.
      const byName = new Map(advertised.map((t) => [t.name, t]))
      const hooked = new Map(
        Object.entries(shaped.tools ?? {}).flatMap(([name, d]) => {
          const t = given.get(d) ?? byName.get(name)
          return t ? [[name, { ...t, description: d.description, inputSchema: d.input }] as const] : []
        }),
      )
      // Context hooks may intentionally trim active CodeMode tools. Do not re-add those here.
      // Only restore denied schemas for Zen's brittle tool-list validator; Tool.snapshot.execute
      // has no executor for them, so a model cannot use this as a permission bypass.
      for (const candidate of deniedCompatibility) {
        if (!hooked.has(candidate.name) && hooked.size < ZEN_TOOL_LIMIT) hooked.set(candidate.name, candidate)
      }
      const entries = Object.entries(shaped.options)
      const generation = Object.fromEntries(entries.filter(([k]) => GENERATION_KEYS.has(k))) as GenerationOptionsFields
      const providerOptions = Object.fromEntries(entries.filter(([k]) => !GENERATION_KEYS.has(k)))
      const affinity = SessionAffinity.get(session)
      // Zen's free-tier gate rejects anything outside OpenCode's own id shape with 403 "free tier
      // can only be used from within OpenCode". It reads both `x-opencode-session` and
      // `x-opencode-session-id`; a hashed `x-opencode-session` alone is not enough, so the
      // well-formed token goes into both. A group chat keeps a derived id (`ses_group_…`) so
      // reopening the group finds the same chat. Other providers and the remaining headers keep
      // the real id.
      const gateway =
        model.ref.providerID === "opencode" ? SessionAffinity.gateway(session) : affinity
      // Only the agent loop resends a growing history; titles, summaries, and generation are one-shot.
      const prefix =
        kind === "primary"
          ? pin({
              sessionID: session.id,
              key: `${input.agent}\u0000${model.ref.providerID}/${model.ref.id}`,
              system: shaped.system,
              messages: shaped.messages,
            })
          : shaped
      const base = LLM.request({
        model: model.model,
        http: {
          headers: {
            "x-opencode-session-id": model.ref.providerID === "opencode" ? gateway : session.id,
            ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
            "x-session-affinity": affinity,
            "X-Session-Id": affinity,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
            "User-Agent": App.useragent(app),
            "x-opencode-project": session.projectID,
            "x-opencode-session": gateway,
            "x-opencode-client": app.name,
          },
        },
        // TODO: Persist cache lineage so nested forks reuse the root session's cache key.
        promptCacheKey: /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity,
        system: [...prefix.system],
        messages: boundImages(unsupportedParts([...prefix.messages], model.capabilities, model.model.provider)),
        tools: Array.from(hooked, ([name, t]) => ({ ...t, name })),
        toolChoice: input.toolChoice,
        generation: Object.keys(generation).length === 0 ? undefined : generation,
        providerOptions: Object.keys(providerOptions).length === 0 ? undefined : providerOptions,
      })

      const baseURL = base.model.route.endpoint.baseURL
      const modelHook = yield* hooks.trigger("session", "model.request", {
        ...scope,
        baseURL: typeof baseURL === "string" ? baseURL : undefined,
        headers: { ...base.http?.headers },
      })
      const route =
        modelHook.baseURL !== undefined && modelHook.baseURL !== baseURL
          ? base.model.route.with({ endpoint: { baseURL: modelHook.baseURL } })
          : base.model.route
      const request = LLMRequest.update(base, {
        model: route === base.model.route ? base.model : LanguageModel.update(base.model, { route }),
        http: new HttpOptions({
          ...base.http,
          headers: Object.keys(modelHook.headers).length === 0 ? undefined : modelHook.headers,
        }),
      })
      // History selects native windows against the catalog route before hooks run. A newly installed
      // routing hook must not send an existing opaque window to another deployment; `prepare` has no
      // error channel, so like hook failures this surfaces as a defect.
      const selected = SessionProviderContext.provenance(model)
      if (
        selected &&
        !SessionProviderContext.compatible(
          selected,
          SessionProviderContext.provenance({ model: request.model, ref: model.ref }),
        ) &&
        request.messages.some((message) => message.content.some((part) => part.type === "compaction"))
      )
        return yield* Effect.die(
          new Error("Provider context is incompatible with the route selected by model request hooks"),
        )
      if (kind === "primary" && SessionRequestReport.enabled())
        yield* SessionRequestReport.write({ sessionID: session.id, agent: input.agent, request })

      const hasHttpHooks =
        (yield* hooks.has("session", "http.request", model.ref.providerID)) ||
        (yield* hooks.has("session", "http.response", model.ref.providerID))
      const http: StreamOptions["http"] = hasHttpHooks
        ? (req, handler) =>
            Effect.gen(function* () {
              const before = yield* hooks.trigger("session", "http.request", {
                ...scope,
                request: yield* HttpClientRequest.toWeb(req),
              })
              let sent = HttpClientRequest.fromWeb(before.request)
              if (before.request.body)
                sent = HttpClientRequest.bodyUint8Array(
                  sent,
                  new Uint8Array(yield* Effect.promise(() => before.request.clone().arrayBuffer())),
                  before.request.headers.get("content-type") ?? undefined,
                )
              const res = yield* handler(sent)
              const after = yield* hooks.trigger("session", "http.response", {
                ...scope,
                request: before.request,
                response: new Response(
                  [204, 205, 304].includes(res.status) ? null : yield* Stream.toReadableStreamEffect(res.stream),
                  { status: res.status, headers: res.headers },
                ),
              })
              return HttpClientResponse.fromWeb(sent, after.response)
            }).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))))
        : undefined
      // HTTP hooks wrap every HTTP request, including the WebSocket fallback path. The route decides
      // which transport actually carries the request, so both hook families are always offered.
      const webSocket =
        input.webSocket === "session" && model.transport === "websocket"
          ? transport.bind(
              session.id,
              {
                handshake: (connect) =>
                  hooks
                    .trigger("session", "experimental.ws.handshake", {
                      ...scope,
                      url: connect.url,
                      headers: connect.headers,
                    })
                    .pipe(Effect.map((event) => ({ url: event.url, headers: event.headers }))),
                send: (frame) =>
                  hooks
                    .trigger("session", "experimental.ws.send", { ...scope, frame })
                    .pipe(Effect.map((event) => event.frame)),
                receive: (frame) =>
                  hooks
                    .trigger("session", "experimental.ws.receive", { ...scope, frame })
                    .pipe(Effect.map((event) => event.frame)),
              },
              model.chunkTimeout,
            )
          : undefined

      // A model may call an on-demand tool it has not loaded yet (it saw the name in the index).
      // The call is not run here: the tool skipped this request's context hooks, which may narrow
      // or remove it. The call itself loads the tool, so the next request offers it through them.
      const unloaded = (name: string) => tools.lazy?.has(name) === true && !picked.has(name)

      const guidedInStep = new Set<string>()

      const isToolCalled = (name: string) => {
        if (guidedInStep.has(name)) return true
        return input.messages.some((message) => {
          if (message.content.some((part) => part.type === "tool-call" && part.name === name)) return true
          if (message.role === "user") {
            return message.content.some(
              (part) =>
                part.type === "text" &&
                (part.text.includes("<conversation-checkpoint>") || part.text.includes("<summary>")) &&
                (part.text.includes(`[Assistant tool call]: ${name}(`) ||
                  part.text.includes(`tool call]: ${name}(`) ||
                  part.text.includes(`"${name}"`)),
            )
          }
          return false
        })
      }

      // A tool's guide arrives as the answer to the session's first call of it, before that call
      // can act. Every later call finds the first one in history and runs.
      const unguided = (name: string) => {
        const guide = tools.guides?.get(name)
        // A tool a context hook removed stays unreachable; execute refuses it as before.
        if (!guide || !hooked.has(name)) return undefined
        if (isToolCalled(name)) return undefined
        guidedInStep.add(name)
        return guide
      }
      return {
        event: shaped,
        request,
        options: { ...(http ? { http } : {}), ...(webSocket ? { webSocket } : {}) },
        retry: (event: Parameters<Prepared["retry"]>[0]) =>
          hooks.trigger("session", "retry", event).pipe(Effect.asVoid),
        // Permission.assert and the question tool throw declines as defects so tools cannot
        // catch them and turn a "no" into model-visible output. Recover them here as failures.
        executeTool: (call: Parameters<Prepared["executeTool"]>[0]) => {
          const guide = unguided(call.call.name)
          return (unloaded(call.call.name)
            ? Effect.fail(
                new Tool.Error({
                  message: `${call.call.name} was not loaded for this step. It is loaded now: call it again.`,
                }),
              )
            : guide !== undefined
              ? Effect.succeed<Tool.NormalizedResult>({
                  content: [
                    {
                      type: "text" as const,
                      text: `${guide}\n\nThis is how ${call.call.name} works; the call did not run. Call it again with what you need.`,
                    },
                  ],
                })
              : tools.execute({ ...call, definitions: hooked })
          ).pipe(
            Effect.catchCauseFilter(
              (cause) => {
                const decline = cause.reasons.flatMap((r) =>
                  Cause.isDieReason(r) &&
                  (r.defect instanceof Permission.DeclinedError || r.defect instanceof QuestionTool.CancelledError)
                    ? [r.defect]
                    : [],
                )[0]
                return decline ? Result.succeed(decline) : Result.fail(cause)
              },
              (decline) => Effect.fail(decline),
            ),
          )
        },
      }
    })

    const agentHook =
      (name: "context" | "compaction" | "generate", agent: Agent.ID) => (draft: SessionRequest, tools: Definitions) =>
        hooks.trigger("session", name, { ...draft, agent, tools })

    return Service.of({
      primary: (input) => prepare("primary", input, agentHook("context", input.agent)),
      compaction: (input) => prepare("compaction", input, agentHook("compaction", input.agent)),
      generate: (input) => prepare("generate", input, agentHook("generate", input.agent)),
      title: (input) => prepare("title", input, (draft) => hooks.trigger("session", "title", draft)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginHooks.node, SessionModelTransport.node, App.node],
})
