export * as SessionCompaction from "./compaction.js"

import {
  AIError,
  type ContentPart,
  InvalidProviderOutputError,
  InvalidRequestError,
  isContextOverflowFailure,
  LLMClient,
  LLMEvent,
  LLMRequest,
  Message,
  type ToolEntry,
  UnknownProviderError,
  type Usage,
} from "@orchestra/ai"
import type { StreamOptions } from "@orchestra/ai/route"
import type { SessionCompactionResult } from "@orchestra/plugin/effect/session"
import type { SessionError } from "@orchestra/schema/session-error"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Context, Effect, Layer, Result, Stream } from "effect"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { llmClient } from "../effect/app-node-platform.js"
import { Model } from "../model.js"
import { State } from "../state.js"
import { Token } from "../util/token.js"
import type { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import { SessionHistory } from "./history.js"
import type { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionRunnerRetry } from "./runner/retry.js"
import { toLLMMessages } from "./runner/to-llm-message.js"
import { asRateLimit, contentFilterError, toSessionError } from "./to-session-error.js"
import { SessionUsage } from "./usage.js"

export type Settings = {
  auto: boolean
  /** Tokens kept free below the model's limits before compacting. Unset keeps 10% free. */
  buffer?: number
  /** Tokens of recent conversation kept verbatim beside the summary. */
  keep: number
  /** Most tokens a request carries before automatic compaction, below the window's own ceiling; 0 uses the window. */
  threshold: number
  /** Share (0-100) of the model's context window in use before automatic compaction runs; set from the Settings dialog. */
  thresholdPercent?: number
  /** Share (0-100) of the window left free after a compact, for the reply and a safety margin. */
  keepFreePercent?: number
}

export type Editor = {
  configure: (settings: Partial<Settings>) => void
}

export type Trigger =
  /** `overflow`: the provider just rejected this context as too long. */
  | { readonly reason: "auto" | "overflow"; readonly context: SessionContext.Loaded }
  /** `inputID` is the `/compact` inbox item, whose message shows the outcome. */
  | { readonly reason: "manual"; readonly context: SessionContext.Loaded; readonly inputID: SessionMessage.ID }

export type Outcome =
  /** Only `auto` skips: the context fits, or automatic compaction is off. */
  | { readonly status: "skipped" }
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: SessionError.Error }

export interface Interface extends State.Transformable<Editor> {
  readonly compact: (trigger: Trigger) => Effect.Effect<Outcome>
  readonly settings: Effect.Effect<Settings>
  readonly getSettings: () => Settings
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/SessionCompaction") {}

/**
 * Parses user input or configuration string/number into token count.
 * Handles "400k", "400K", "1.5m", "200000", "0", "Без сжатия", "Full window", etc.
 */
export function parseCompactionThreshold(input: string | number | undefined | null): number {
  if (input === undefined || input === null) return 0
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? Math.floor(input) : 0
  }
  if (typeof input !== "string") return 0

  const trimmed = input.trim().toLowerCase()
  if (
    !trimmed ||
    trimmed === "0" ||
    trimmed === "без сжатия" ||
    trimmed === "без лимита" ||
    trimmed === "весь лимит" ||
    trimmed === "весь" ||
    trimmed === "full window" ||
    trimmed === "full" ||
    trimmed === "all" ||
    trimmed === "max" ||
    trimmed === "none" ||
    trimmed === "off" ||
    trimmed === "disabled" ||
    trimmed === "no limit" ||
    trimmed === "unlimited"
  ) {
    return 0
  }

  const cleaned = trimmed.replace(/[,_\s]/g, "")
  const match = cleaned.match(/^([0-9]+(?:\.[0-9]+)?)([kmb]?)$/i)
  if (!match) {
    const fallback = parseFloat(cleaned)
    return Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : 0
  }

  const num = parseFloat(match[1])
  if (!Number.isFinite(num) || num <= 0) return 0

  const unit = match[2].toLowerCase()
  let multiplier = 1
  if (unit === "k") multiplier = 1_000
  else if (unit === "m") multiplier = 1_000_000
  else if (unit === "b") multiplier = 1_000_000_000

  return Math.floor(num * multiplier)
}

/**
 * Formats a token threshold into human-readable representation.
 * 400000 -> "400k", 1500000 -> "1.5m", 0 -> "Без сжатия" (or "Full window").
 */
export function formatCompactionThreshold(
  tokens: number | undefined | null,
  options?: { fallback?: string; locale?: string } | string,
): string {
  const fallback =
    typeof options === "string"
      ? options
      : (options?.fallback ?? (options?.locale === "en" ? "Full window" : "Без сжатия"))

  if (tokens === undefined || tokens === null || !Number.isFinite(tokens) || tokens <= 0) {
    return fallback
  }

  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000
    return `${Number(val.toFixed(2))}m`
  }

  if (tokens >= 1_000) {
    const val = tokens / 1_000
    return `${Number(val.toFixed(2))}k`
  }

  return `${Math.floor(tokens)}`
}

/** A summary fills `text` and `recent`; a native compaction fills `providerContext`. */
type Result = {
  readonly text: string
  // todo: this should become a msg reference, we shouldnt be stringifying the recent history (confuses some models...)
  readonly recent: string
  // todo: consolidate these 2
  readonly providerState?: SessionMessage.ProviderState
  readonly providerContext?: SessionProviderContext.Info
  readonly metadata?: Record<string, unknown>
}

type Failure = {
  readonly error: SessionError.Error
}

type Prepared = Effect.Success<ReturnType<SessionModelRequest.Interface["compaction"]>>

type Streamed = {
  readonly text: string
  readonly providerState?: SessionMessage.ProviderState
}

const NOTHING_TO_COMPACT: Failure = { error: { type: "compaction.unavailable", message: "Nothing to compact yet" } }
/** After each "too long" rejection, the next attempt aims at this share of the first rejected request's size. */
const SHRINK_STEPS = [0.7, 0.5, 0.35]
// The least of the window kept free for the last reply before compaction and for the summary itself.
const RESERVE_MIN = 16_000
/** A common window size, assumed for the compaction request when the model's window is unknown. */
const UNKNOWN_WINDOW = 1_000_000
const TOOL_OUTPUT_MAX_CHARS = 1_250
const IMAGE_TOKEN_ESTIMATE = 1_500
const PDF_TOKEN_ESTIMATE = 2_000

const SUMMARY_TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>`

const SUMMARY_RULES = `Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not mention the summary process or that context was compacted.`

export const buildPrompt = (update: boolean, legacy = false) => {
  const shared = [
    "Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.",
    SUMMARY_TEMPLATE,
    SUMMARY_RULES,
    "Do not continue the task or call tools.",
    "Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
  ]
  if (!update) {
    return [
      "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
      ...shared,
    ].join("\n\n")
  }
  return [
    "Update the existing checkpoint in the conversation above into one consolidated summary.",
    // Before #48058 (Sep 2026), summaries kept nearly everything: every file touched, per-edit changelogs,
    // restated AGENTS.md conventions, and an "Additional Context" section that grew on every update. The
    // preserve-first update prompt would carry that detail forward indefinitely, so a checkpoint from that
    // template is rewritten once at the current level of detail. The rewrite uses the new headings, so later
    // updates skip this. Remove once no session still in use has a latest checkpoint older than #48058.
    ...(legacy
      ? [
          "The existing checkpoint was written with an earlier format that recorded far more detail than this one asks for. Rewrite it at the level of detail described below rather than carrying its detail forward. Keep its requirements, decisions, and open questions; they came from earlier conversation with the user.",
        ]
      : []),
    "Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale. If something is no longer relevant to continuing the work, you may remove it.",
    "Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work.",
    "Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>`, `<summary>`, or `<recent-context>` wrapper tags from the previous checkpoint.",
    ...shared,
  ].join("\n\n")
}

const NUDGE =
  "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template."

const SUMMARY_HEADINGS = [
  "## Objective",
  "## Requirements",
  "## Decisions",
  "## Work State",
  "## Next Move",
  "## Relevant Files",
  "## Important Context",
] as const

/**
 * Fast summary structure validation with zero allocations and early exit.
 * Checks for heading prefixes without allocating regexes or closures.
 */
export const isSummaryFilled = (text: string): boolean => {
  if (!text || text.indexOf("## ") === -1) return false
  for (let i = 0; i < SUMMARY_HEADINGS.length; i++) {
    if (text.indexOf(SUMMARY_HEADINGS[i]!) !== -1) return true
  }
  return false
}

export type CheckpointData = {
  readonly summary: string
  readonly recent?: string
}

/**
 * Fast, allocation-conscious semantic checkpoint parser.
 * Extracts <conversation-checkpoint>, <summary>, and <recent-context> tags
 * without regex or redundant string allocations.
 */
export function parseCheckpoint(text: string): CheckpointData | undefined {
  const startTag = "<conversation-checkpoint>"
  const startIndex = text.indexOf(startTag)
  if (startIndex === -1) return undefined

  const contentStart = startIndex + startTag.length
  const endTag = "</conversation-checkpoint>"
  const endIndex = text.indexOf(endTag, contentStart)
  const inner = endIndex === -1 ? text.slice(contentStart) : text.slice(contentStart, endIndex)

  const summaryOpen = "<summary>"
  const summaryClose = "</summary>"
  const summaryStart = inner.indexOf(summaryOpen)
  let summary = ""
  let recent: string | undefined

  if (summaryStart !== -1) {
    const afterSummary = summaryStart + summaryOpen.length
    const summaryEnd = inner.indexOf(summaryClose, afterSummary)
    summary = (summaryEnd === -1 ? inner.slice(afterSummary) : inner.slice(afterSummary, summaryEnd)).trim()
  } else {
    const recentOpen = "<recent-context>"
    const recentStartIdx = inner.indexOf(recentOpen)
    summary = (recentStartIdx === -1 ? inner : inner.slice(0, recentStartIdx)).trim()
  }

  const recentOpen = "<recent-context>"
  const recentClose = "</recent-context>"
  const recentStart = inner.indexOf(recentOpen)
  if (recentStart !== -1) {
    const afterRecent = recentStart + recentOpen.length
    const recentEnd = inner.indexOf(recentClose, afterRecent)
    recent = (recentEnd === -1 ? inner.slice(afterRecent) : inner.slice(afterRecent, recentEnd)).trim()
  }

  return { summary, recent }
}

/** Summaries written with the previous template carry this catch-all heading. */
const LEGACY_HEADING = "## Additional Context"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const catalog = yield* Model.Service
    const models = yield* SessionRunnerModel.Service
    const db = (yield* Database.Service).db
    const requests = yield* SessionModelRequest.Service

    const state = State.create<Settings, Editor>({
      name: "session-compaction",
      // Default threshold: 0 means use the model's full context window (with safety buffer).
      // auto: true enables automatic compaction before the context window overflows.
      initial: () => ({ auto: true, keep: 15_000, threshold: 0 }),
      editor: (settings) => ({
        configure: (update) => {
          Object.assign(settings, update)
        },
      }),
    })

    const compact = Effect.fn("SessionCompaction.compact")(function* (trigger: Trigger): Effect.fn.Return<Outcome> {
      const settings = state.get()
      const context = trigger.context

      // Only the user compacts when automatic compaction is off, except on overflow rejections where compaction recovers.
      if (trigger.reason === "auto" && !settings.auto) return { status: "skipped" }

      const sessionThreshold =
        context.session.metadata?.compaction_threshold !== undefined
          ? parseCompactionThreshold(context.session.metadata.compaction_threshold as any)
          : undefined

      const contextCeiling = calculateCeiling(context.model.limit, settings.buffer, settings.keepFreePercent)

      const thresholdLimit =
        sessionThreshold === 0
          ? Number.POSITIVE_INFINITY
          : sessionThreshold !== undefined
            ? sessionThreshold
            : settings.threshold > 0
              ? Math.min(
                  contextCeiling,
                  settings.thresholdPercent !== undefined
                    ? percentCeiling(context.model.limit, settings.thresholdPercent)
                    : settings.threshold,
                )
              : settings.thresholdPercent !== undefined
                ? Math.min(contextCeiling, percentCeiling(context.model.limit, settings.thresholdPercent))
                : contextCeiling

      // An unknown window never triggers auto compaction
      if (trigger.reason === "auto" && !context.model.limit.context && !context.model.limit.input) {
        return { status: "skipped" }
      }

      if (trigger.reason === "auto" && !due(context, thresholdLimit))
        return { status: "skipped" }
      const native = context.model.compaction?.type === "native"
      const agent = native ? undefined : yield* agents.get(Agent.ID.make("compaction"))
      const model =
        (agent?.model &&
          (yield* models
            .resolve({ ...context.session, model: agent.model }, catalog.available)
            .pipe(Effect.orElseSucceed(() => undefined)))) ??
        context.model
      const ceiling = calculateCeiling(model.limit, settings.buffer, settings.keepFreePercent)
      // An unknown window never triggers auto compaction, but the compaction request still needs a size to aim for.
      const cap = Number.isFinite(ceiling)
        ? ceiling
        : calculateCeiling({ ...model.limit, context: UNKNOWN_WINDOW }, settings.buffer, settings.keepFreePercent)
      // The provider just rejected this context, so the estimate ran low; the first attempt already aims below it.
      const budget =
        trigger.reason === "overflow" ? Math.min(cap, Math.floor(estimateContext(context) * SHRINK_STEPS[0])) : cap

      const selected = model === context.model ? trigger : { ...trigger, context: { ...context, model } }
      const compaction = native
        ? compactNatively(selected, budget, settings.keep)
        : summarize(selected, budget, settings.keep)
      return yield* compaction.pipe(
        Effect.matchEffect({
          onSuccess: (result) => publish(selected, result),
          onFailure: (failure) => publish(selected, failure),
        }),
      )
    })

    const due = (context: SessionContext.Loaded, ceiling: number) => {
      const messages = context.messages
      // A compaction just completed; let the runner rebuild the request from it first.
      const last = messages.at(-1)
      if (last?.type === "compaction" && last.status === "completed") return false
      // An encrypted native window estimates as nothing, so wait for a response to measure it.
      const measured = messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
      if (measured < messages.findLastIndex(SessionProviderContext.isCheckpoint)) return false
      return estimateContext(context) >= ceiling
    }

    /**
     *   first:  [E1 … E8][E9 E10]                  →  [S1 + "E9 E10"]
     *   again:  [S1 + "E9 E10"][E11 … E18][E19]    →  [S2 + "E19"]      S2 covers S1, E9 E10, and E11–E18
     *
     * The model is sent the older part, then the summary prompt:
     *
     *   [system][S1 + "E9 E10"][E11 … E18][prompt]    plus one nudge if the reply skips the template
     *
     * Later requests open with the checkpoint as one user message:
     *
     *   <conversation-checkpoint>
     *     <summary>S2</summary>
     *     <recent-context>E19</recent-context>
     *   </conversation-checkpoint>
     *   [new messages…]
     *
     * E = one exchange: a user message and the replies to it. S = a summary. [S + "…"] = one checkpoint: a summary
     * plus the newest `keep` tokens of messages, saved as text.
     */
    const summarize = Effect.fnUntraced(function* (
      trigger: Trigger,
      budget: number,
      keep: number,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      const split = splitConversation(context.messages, keep)
      if (!split) return yield* Effect.fail(NOTHING_TO_COMPACT)

      const previous = previousCompaction(context.messages)
      const prompt = buildPrompt(previous !== undefined, previous?.summary.includes(LEGACY_HEADING) ?? false)
      const prepared = yield* prepare(context, split.older, budget)

      // Hooks saw the request without the summary prompt, so it is appended here. A reply that ignores the
      // template gets one reminder before it counts as a failure.
      const send = (request: LLMRequest) =>
        Effect.gen(function* () {
          const prompted = LLMRequest.update(request, { messages: [...request.messages, Message.user(prompt)] })
          const reply = yield* stream(context, prompted, prepared.options)
          const parsed = parseCheckpoint(reply.text)
          const text = parsed?.summary ? parsed.summary : reply.text
          const recent = parsed?.recent ? parsed.recent : split.recent
          if (isSummaryFilled(text)) return { ...reply, text, recent }

          const nudged = LLMRequest.update(prompted, { messages: [...prompted.messages, Message.user(NUDGE)] })
          const retry = yield* stream(context, nudged, prepared.options)
          const parsedRetry = parseCheckpoint(retry.text)
          const retryText = parsedRetry?.summary ? parsedRetry.summary : retry.text
          const retryRecent = parsedRetry?.recent ? parsedRetry.recent : split.recent
          if (isSummaryFilled(retryText)) return { ...retry, text: retryText, recent: retryRecent }
          return yield* Effect.fail<Failure>({
            error: {
              type: "compaction.failed",
              message: retryText.trim()
                ? "Compaction summary did not match the required template"
                : "Compaction produced no summary",
            },
          })
        })

      const overhead = Token.estimate(prompt) + Token.estimate(NUDGE)
      return yield* deliver(trigger, prepared, split.recent, budget - overhead, send)
    })

    /**
     *   endpoint:  [window]                      →  [U U][item]    the provider picks which messages to keep
     *   trigger:   [window][compaction_trigger]  →  [item]
     *                                            →  [U U][item]    we add the newest user messages within `keep`
     *
     * Later requests open with that replacement window in place of the history it covers:
     *
     *   [U U][item][new messages…]
     *
     * window = the previous compaction and everything since. item = one encrypted compaction item, which only
     * replays on the endpoint that made it. U = a user message as typed.
     */
    const compactNatively = Effect.fnUntraced(function* (
      trigger: Trigger,
      budget: number,
      keep: number,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      if (!context.messages.some(messageToText)) return yield* Effect.fail(NOTHING_TO_COMPACT)
      const unsupported = (message: string) =>
        Effect.fail<Failure>({ error: { type: "provider.unsupported-operation", message } })
      const prepared = yield* prepare(context, context.messages, budget, "session")

      // History is selected before request hooks, so a hook that reroutes the request cannot be honored here.
      const provenance = SessionProviderContext.provenance(context.model)
      if (!provenance) return yield* unsupported("Provider compaction requires a stable, configured endpoint")
      const routed = SessionProviderContext.provenance({ model: prepared.request.model, ref: context.model.ref })
      if (!SessionProviderContext.compatible(provenance, routed)) {
        return yield* unsupported(
          "Provider compaction requires the endpoint in provider/model settings, not a model.request rewrite",
        )
      }

      const toResult = (window: ReadonlyArray<Message>, usage: Usage | undefined) =>
        spend(context.session.id, usage && SessionUsage.record(usage, context.model.cost)).pipe(
          Effect.as<Result>({
            text: "",
            recent: "",
            providerContext: SessionProviderContext.encode(provenance, window),
          }),
        )

      const send = (request: LLMRequest) => {
        if (LLMClient.canCompact(request, { mechanism: "trigger" })) {
          return Effect.gen(function* () {
            const history = yield* SessionHistory.load(db, context.session.id, "local").pipe(Effect.orDie)
            const retained = recentUserMessages(history, context.model, keep)
            const response = yield* llm.compact(request, { ...prepared.options, mechanism: "trigger" })
            return yield* toResult([...retained, Message.assistant(response.checkpoint)], response.usage)
          })
        }
        if (LLMClient.canCompact(request)) {
          return llm
            .compact(request, { mechanism: "endpoint", http: prepared.options.http })
            .pipe(Effect.flatMap((response) => toResult(response.replacement, response.usage)))
        }
        return unsupported(`Native compaction is not supported for ${request.model.provider}/${request.model.route.id}`)
      }

      return yield* deliver(trigger, prepared, "", budget, send)
    })

    /**
     * Sends the request as-is if it is estimated to fit `target`, and as text otherwise (see `flattenAndDropOldest`).
     * Limits and estimates can be wrong, so until the provider rejects something as too long, a request that cannot
     * be made to fit is sent whole: unchanged, or as text once its media has to go. A "too long" rejection means the
     * estimate ran low, so the next attempts aim at 70%, 50%, then 35% of the first rejected request's estimate, and a
     * rejection after those gives up. A "payload too large" rejection is about bytes, which inline media almost always
     * accounts for, so one on the unchanged request resends it as text, which carries no media, without counting; one
     * on text counts as "too long". Other provider errors resend the same request under the session's retry policy. A
     * `Failure` from `send` is a reply that cannot be used, and is never retried.
     */
    const deliver = Effect.fnUntraced(function* (
      trigger: Trigger,
      prepared: Prepared,
      recent: string,
      target: number,
      send: (request: LLMRequest) => Effect.Effect<Result, AIError | Failure>,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      // The runner opened the manual compaction's message when it delivered the `/compact` item.
      if (trigger.reason !== "manual") {
        yield* bus.publish(SessionEvent.Compaction.Started, { sessionID: context.session.id, reason: "auto", recent })
      }
      if (prepared.event.result) return yield* fromHook(context, prepared.event.result, recent)

      const policy = yield* SessionRunnerRetry.policy(context.session.id)
      let rejections = 0
      let rejected: number | undefined
      let asText = false
      let flattener: ReturnType<typeof createFlattener> | undefined

      while (true) {
        const fits = !asText && estimateRequest(prepared.request) <= target
        const request = fits
          ? prepared.request
          : ((flattener ??= createFlattener(prepared.request, context)).dropOldest(target) ??
            (rejections > 0
              ? undefined
              : asText
                ? flattener.dropOldest(Number.POSITIVE_INFINITY)
                : prepared.request))
        if (!request) {
          return yield* Effect.fail<Failure>({
            error: {
              type: "compaction.failed",
              message:
                "The compaction request cannot be reduced further without losing the latest exchange or checkpoint",
            },
          })
        }

        const attempt = yield* Effect.result(send(request))
        if (Result.isSuccess(attempt)) return attempt.success
        const failure = attempt.failure
        if (!(failure instanceof AIError)) return yield* Effect.fail(failure)
        const cause = asRateLimit(failure)
        const error = toSessionError(cause)
        const tooLarge = cause.reason._tag === "InvalidRequest" && cause.reason.classification === "payload-too-large"

        if (tooLarge && request === prepared.request) {
          asText = true
          continue
        }

        if (tooLarge || isContextOverflowFailure(cause)) {
          const step = SHRINK_STEPS[rejections]
          if (step === undefined) return yield* Effect.fail<Failure>({ error })
          rejected ??= estimateRequest(request)
          target = Math.floor(rejected * step)
          rejections++
          continue
        }

        const decision = yield* policy({
          cause,
          error,
          agent: context.agent.id,
          model: context.model.ref,
          hook: prepared.retry,
          retry: SessionRunnerRetry.isRetryable(cause),
        })
        if (!decision.retry) return yield* Effect.fail<Failure>({ error })
        yield* Effect.sleep(decision.delay)
      }
    })

    const note = (omitted: number) =>
      omitted ? `[${omitted} older ${omitted === 1 ? "exchange" : "exchanges"} omitted]\n\n` : ""

    const createFlattener = (request: LLMRequest, context: SessionContext.Loaded) => {
      const previous = previousCompaction(context.messages)
      const end =
        request.messages.findLastIndex(
          (message) =>
            (previous !== undefined && message.id === previous.id) ||
            message.content.some((part) => part.type === "compaction"),
        ) + 1
      const summary = previous !== undefined && !SessionProviderContext.isCheckpoint(previous) ? previous : undefined
      // TODO: Read the previous summary from the hooked request once it no longer merges summary and recent into one
      // message. Until then it is rebuilt from storage, which drops a compaction hook's edits to that message.
      const lead = summary
        ? toLLMMessages([{ ...summary, recent: "" }], context.model.ref)
        : request.messages.slice(0, end)

      // A user message and everything after it, up to the next one, is one exchange: kept or dropped whole.
      const exchanges: string[] = summary?.recent ? [summary.recent] : []
      for (let i = end; i < request.messages.length; i++) {
        const message = request.messages[i]
        const text = flattenMessage(message)
        if (!text) continue
        if (message.role === "user" || exchanges.length === 0) exchanges.push(text)
        else exchanges[exchanges.length - 1] += `\n${text}`
      }

      const exchangeSizes = exchanges.map((text) => Token.estimate(text) + 1)
      const leadTokens = estimateRequest({ system: request.system, tools: request.tools, messages: lead })
      const noteTemplateTokens = Token.estimate(note(exchanges.length))

      const dropOldest = (target: number) => {
        const room = target - leadTokens - noteTemplateTokens
        const start = oldestToDropPrecomputed(exchangeSizes, room)
        const kept = exchanges.slice(start)
        if (kept.length === 0) return undefined
        const omitted = exchanges.length - kept.length
        return LLMRequest.update(request, {
          messages: [...lead, Message.user(note(omitted) + kept.join("\n\n"))],
        })
      }

      return { dropOldest }
    }

    // Flattening and exchange dropping logic is encapsulated in createFlattener

    const stream = (context: SessionContext.Loaded, request: LLMRequest, options: StreamOptions) => {
      const sessionID = context.session.id
      const metadataKey = context.model.model.route.providerMetadataKey ?? context.model.model.provider
      const unusable = (error: SessionError.Error) => Effect.fail<Failure>({ error })

      return llm.stream(request, options).pipe(
        Stream.runFoldEffect(
          (): Streamed => ({ text: "" }),
          (streamed, event): Effect.Effect<Streamed, AIError | Failure> => {
            if (LLMEvent.is.providerError(event)) {
              if (event.classification === undefined)
                return unusable({ type: "provider.error", message: event.message })
              return Effect.fail(
                new AIError({
                  reason: new InvalidRequestError({ message: event.message, classification: event.classification }),
                }),
              )
            }

            if (LLMEvent.is.textDelta(event)) {
              return bus
                .publish(SessionEvent.Compaction.Delta, { sessionID, text: event.text })
                .pipe(Effect.as({ ...streamed, text: streamed.text + event.text }))
            }

            if (LLMEvent.is.stepFinish(event)) {
              return spend(sessionID, SessionUsage.record(event.usage, context.model.cost)).pipe(
                Effect.as({ ...streamed, providerState: event.providerMetadata?.[metadataKey] }),
              )
            }

            if (!LLMEvent.is.finish(event)) return Effect.succeed(streamed)
            switch (event.reason.normalized) {
              case "unknown":
                return Effect.fail(
                  new AIError({
                    reason: new InvalidProviderOutputError({
                      message: "The provider response ended with an unknown finish reason.",
                      classification: "incomplete-stream",
                    }),
                  }),
                )
              case "error":
                return Effect.fail(
                  new AIError({ reason: new UnknownProviderError({ message: "Compaction generation failed" }) }),
                )
              case "length":
                return unusable({
                  type: "compaction.failed",
                  message: "Compaction summary reached the output token limit",
                })
              case "content-filter":
                return unusable(contentFilterError("Compaction summary was blocked by the provider", event.reason))
              default:
                return Effect.succeed(streamed)
            }
          },
        ),
      )
    }

    /**
     * The conversation as the runner would send it, after request hooks.
     *
     * The output limit leaves room for `budget`, the most `deliver` sends. The request prepared here can be larger
     * when the conversation overshot the threshold, and is only shrunk to fit after hooks have seen it, so sizing the
     * output to it would leave next to no room. A prompt the estimate undersells is rejected and shrunk like any
     * other.
     */
    const prepare = (
      context: SessionContext.Loaded,
      messages: ReadonlyArray<SessionMessage.Info>,
      budget: number,
      webSocket?: "session",
    ) => {
      const base = transcript(context, messages)
      return requests.compaction({
        session: context.session,
        agent: context.agent.id,
        model: context.model,
        tools: context.tools,
        system: base.system,
        messages: base.messages,
        webSocket,
        inputTokens: { measured: budget, estimated: 0 },
      })
    }

    /** A request hook supplied the summary itself, so no model call happens. */
    const fromHook = (context: SessionContext.Loaded, supplied: SessionCompactionResult, recent: string) => {
      const usage = supplied.tokens && {
        tokens: supplied.tokens,
        cost: SessionUsage.calculateCost(context.model.cost, supplied.tokens),
      }
      return spend(context.session.id, usage).pipe(
        Effect.as<Result>({
          text: supplied.summary,
          recent,
          providerState: supplied.providerState,
          metadata: supplied.metadata,
        }),
      )
    }

    /**
     * Each model call is billed as soon as it finishes, so failed and interrupted compactions are billed too. The
     * compaction's message shows the total across all of its calls. A session never runs two compactions at once.
     */
    const spent = new Map<SessionContext.Loaded["session"]["id"], SessionUsage.Recorded>()
    const spend = (sessionID: SessionContext.Loaded["session"]["id"], usage: SessionUsage.Recorded | undefined) =>
      Effect.gen(function* () {
        if (!usage) return
        const total = spent.get(sessionID)
        spent.set(sessionID, total ? SessionUsage.add(total, usage) : usage)
        yield* bus.publish(SessionEvent.UsageRecorded, { sessionID, source: "compaction", ...usage })
      })

    const publish = Effect.fnUntraced(function* (
      trigger: Trigger,
      outcome: Result | Failure,
    ): Effect.fn.Return<Outcome> {
      const context = trigger.context
      const sessionID = context.session.id
      const reason = trigger.reason === "manual" ? "manual" : "auto"
      const usage = spent.get(sessionID)

      if ("error" in outcome) {
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason,
          inputID: trigger.reason === "manual" ? trigger.inputID : undefined,
          error: outcome.error,
          ...usage,
        })
        return { status: "failed", error: outcome.error }
      }

      yield* bus.publish(
        SessionEvent.Compaction.Ended,
        {
          sessionID,
          reason,
          model: context.model.ref,
          providerState: outcome.providerState,
          providerContext: outcome.providerContext,
          text: outcome.text,
          recent: outcome.recent,
          ...usage,
        },
        { metadata: outcome.metadata },
      )
      return { status: "completed" }
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      settings: Effect.sync(() => state.get()),
      getSettings: () => state.get(),
      // A manual compaction settles through its `/compact` inbox item, which the runner owns.
      compact: (trigger) =>
        compact(trigger).pipe(
          Effect.onInterrupt(() =>
            trigger.reason === "manual"
              ? Effect.void
              : publish(trigger, { error: { type: "compaction.interrupted", message: "Compaction was interrupted" } }),
          ),
          Effect.ensuring(Effect.sync(() => spent.delete(trigger.context.session.id))),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Agent.node, Bus.node, Database.node, llmClient, Model.node, SessionModelRequest.node, SessionRunnerModel.node],
})

/** History loads from the latest completed compaction, so a previous one is always the first message. */
const previousCompaction = (messages: ReadonlyArray<SessionMessage.Info>) => {
  const [first] = messages
  return first?.type === "compaction" && first.status === "completed" ? first : undefined
}

const transcript = (context: SessionContext.Loaded, messages: ReadonlyArray<SessionMessage.Info>) =>
  SessionModelRequest.baseTranscript({
    agent: context.agent.info,
    model: context.model,
    tools: context.tools,
    initial: context.initial,
    messages,
  })

/**
 * `older` gets summarized; `recent`, the newest messages within `keep` tokens, is kept verbatim as text beside
 * the summary. Undefined when there is nothing to compact.
 */
const splitConversation = (messages: ReadonlyArray<SessionMessage.Info>, keep: number) => {
  const entries: Array<{ readonly message: SessionMessage.Info; readonly text: string; readonly index: number }> = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    const text = messageToText(message)
    if (text) entries.push({ message, text, index })
  }
  if (entries.length === 0) return undefined

  const recent = entries.slice(recentStart(entries, keep, previousCompaction(messages)))
  return {
    older: messages.slice(0, recent[0]?.index ?? messages.length),
    recent: recent.map((entry) => entry.text).join("\n\n"),
  }
}

const recentStart = (
  entries: ReadonlyArray<{ readonly message: SessionMessage.Info; readonly text: string }>,
  keep: number,
  previous: SessionMessage.CompactionCompleted | undefined,
) => {
  // Drop the oldest entries until the rest fit the allowance, but always keep the newest one.
  const dropped = Math.min(
    oldestToDrop(entries, (entry) => Token.estimate(entry.text), keep),
    entries.length - 1,
  )

  // Start at a user message so an assistant's tool calls and results stay together.
  const userBoundary = entries.findLastIndex((entry, index) => index <= dropped && entry.message.type === "user")
  if (userBoundary > 0) return userBoundary

  // Everything fits. Keep only the latest exchange so there is an older part left to summarize.
  const latestUser = entries.findLastIndex((entry) => entry.message.type === "user")
  if (latestUser > 0) return latestUser

  // One exchange, nothing older. Summarize it all and keep nothing, unless a previous summary already
  // kept recent text, in which case keep everything and summarize only the summary before it.
  return previous?.recent ? 0 : entries.length
}

const oldestToDrop = <T>(items: ReadonlyArray<T>, size: (item: T) => number, budget: number) => {
  let total = 0
  let start = items.length
  while (start > 0) {
    const next = total + size(items[start - 1])
    if (next > budget) break
    total = next
    start--
  }
  return start
}

function oldestToDropPrecomputed(sizes: ReadonlyArray<number>, budget: number) {
  let total = 0
  let start = sizes.length
  while (start > 0) {
    const next = total + sizes[start - 1]
    if (next > budget) break
    total = next
    start--
  }
  return start
}

const messageTextCache = new WeakMap<SessionMessage.Info, string>()

/** One message as the recent, verbatim part of a summary shows it. Empty for messages that part leaves out. */
const messageToText = (message: SessionMessage.Info): string => {
  const cached = messageTextCache.get(message)
  if (cached !== undefined) return cached
  const result = formatMessageToText(message)
  messageTextCache.set(message, result)
  return result
}

const formatMessageToText = (message: SessionMessage.Info): string => {
  switch (message.type) {
    // Earlier summaries and instruction updates are handled outside the recent part.
    case "compaction":
    case "system":
      return ""

    case "user": {
      const skills =
        message.skills?.flatMap((skill) =>
          skill.text === undefined ? [] : [`[Skill activated: ${skill.name}]\n${skill.text}`],
        ) ?? []
      const files =
        message.files?.map((file) => {
          const name = file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")
          return `[Attached ${file.mime}: ${name}]`
        }) ?? []
      return [...skills, `[User]: ${message.text}`, ...files].join("\n")
    }

    case "location-switched":
      return `[User]: The working directory has been changed to ${message.location.directory}.`

    case "assistant":
      return message.content
        .flatMap((part) => {
          if (part.type === "text") return [`[Assistant]: ${part.text}`]
          if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []

          const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
          const call = `[Assistant tool call]: ${part.name}(${input})`
          if (part.state.status === "completed") {
            return [
              call,
              `[Tool result]: ${truncateToolOutput(serializeToolContent(part.state.content, TOOL_OUTPUT_MAX_CHARS))}`,
            ]
          }
          if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error.message}`]
          return [call]
        })
        .join("\n")

    case "synthetic":
      return `[Synthetic context]: ${message.text}`

    case "skill":
      return `[Skill activated: ${message.name}]\n${message.text}`

    case "shell":
      if (message.metadata?.background === true) return ""
      return `[Shell]: ${message.command}\n${truncateToolOutput(message.output?.output ?? "")}`

    default:
      return ""
  }
}

const truncateToolOutput = (value: string) => {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value

  // Count code points so a surrogate pair is never split.
  let end = 0
  let kept = 0
  for (const char of value) {
    if (kept === TOOL_OUTPUT_MAX_CHARS) break
    end += char.length
    kept++
  }
  if (end === value.length) return value
  return `${value.slice(0, end)}\n[truncated]`
}

const flattenedMessageCache = new WeakMap<Message, string>()

/** One request message as a flattened transcript line. Empty for what the transcript leaves out. */
const flattenMessage = (message: Message): string => {
  if (message.role === "system") return ""
  const cached = flattenedMessageCache.get(message)
  if (cached !== undefined) return cached
  const result = formatFlattenMessage(message)
  flattenedMessageCache.set(message, result)
  return result
}

const formatFlattenMessage = (message: Message) => {
  return message.content
    .flatMap((part) => {
      if (part.type === "text")
        return part.text ? [`[${message.role === "user" ? "User" : "Assistant"}]: ${part.text}`] : []
      if (part.type === "media") return [`[${part.media.mediaType} omitted]`]
      if (part.type === "tool-call") return [`[Assistant tool call]: ${part.name}(${JSON.stringify(part.input) ?? ""})`]
      if (part.type !== "tool-result") return []
      const result = part.result
      const output =
        result.type === "content"
          ? serializeToolContent(result.value, TOOL_OUTPUT_MAX_CHARS)
          : typeof result.value === "string"
            ? (result.value.length > TOOL_OUTPUT_MAX_CHARS * 2 ? result.value.slice(0, TOOL_OUTPUT_MAX_CHARS * 2) : result.value)
            : (JSON.stringify(result.value) ?? "")
      const label = result.type === "error" ? "Tool error" : "Tool result"
      return [`[${label}]: ${truncateToolOutput(output)}`]
    })
    .join("\n")
}

const serializeToolContent = (
  content: ReadonlyArray<SessionMessage.ToolStateCompleted["content"][number]>,
  maxChars?: number,
) => {
  const parts: string[] = []
  let accumulated = 0
  for (let i = 0; i < content.length; i++) {
    const item = content[i]
    let piece: string
    if (item.type === "text") {
      piece =
        maxChars !== undefined && item.text.length > maxChars * 2
          ? item.text.slice(0, maxChars * 2)
          : item.text
    } else {
      piece = `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`
    }
    parts.push(piece)
    accumulated += piece.length
    if (maxChars !== undefined && accumulated >= maxChars * 2) break
  }
  return parts.join("\n")
}

/** The newest whole, real user messages within `keep` tokens: no synthetic guidance, no half of an attachment. */
export const recentUserMessages = (
  messages: ReadonlyArray<SessionMessage.Info>,
  model: Pick<SessionContext.Loaded["model"], "ref" | "capabilities">,
  keep: number,
) => {
  const users = messages
    .filter((message) => message.type === "user")
    .map((message) => ({ ...message, skills: undefined }))
  const sendable = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(toLLMMessages(users, model.ref), model.capabilities),
  )
  return sendable.slice(oldestToDrop(sendable, estimateMessage, keep))
}

export const estimateContext = (context: SessionContext.Loaded) => {
  const prompt = estimatePrompt(context)
  return prompt.measured + prompt.estimated
}

/** The prompt size: `measured` is what the provider reported at the latest response, `estimated` is the text since. */
export const estimatePrompt = (context: SessionContext.Loaded) => {
  const anchorIndex = context.messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
  const anchor = context.messages[anchorIndex]
  const base = transcript(context, context.messages.slice(Math.max(0, anchorIndex)))
  // TODO: Pass compaction history the runner has already shaped. This and `recentUserMessages` repeat the
  // runner's unsupported-media and image-budget passes; here the image budget only sees images since the anchor,
  // so image-heavy sessions can estimate high.
  const sent = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(base.messages, context.model.capabilities),
  )
  // The anchor's usage covers its own output, but not its local tool results, which the provider never saw.
  const unmeasured = sent.filter((message) => message.role !== "assistant" || message.id !== anchor?.id)

  if (anchor?.type !== "assistant" || !anchor.tokens)
    return {
      measured: 0,
      estimated: estimateRequest({ system: base.system, tools: context.tools.definitions, messages: unmeasured }),
    }

  const tokens = anchor.tokens
  return {
    measured: tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning,
    estimated: unmeasured.reduce((sum, message) => sum + estimateMessage(message), 0),
  }
}

/**
 * The largest request the model takes while leaving room for its reply: 10% of the window, or `RESERVE_MIN` when that
 * is more. The summary request is capped at the same size, so its output limit is whatever the reserve leaves. A window
 * too small to give up `RESERVE_MIN` keeps 10%.
 */
/** The point in the window (tokens) where a share of it is reached; Infinity when the window is unknown. */
const percentCeiling = (limit: SessionContext.Loaded["model"]["limit"], percent: number) => {
  const window = limit.input || limit.context
  if (window <= 0) return Number.POSITIVE_INFINITY
  return Math.floor(window * (percent / 100))
}

const calculateCeiling = (
  limit: SessionContext.Loaded["model"]["limit"],
  buffer: number | undefined,
  keepFreePercent?: number,
) => {
  // Unknown limits are reported as 0. An unknown input limit falls back to the context window; with no window at
  // all, only a provider rejection can limit the request.
  const window = limit.input || limit.context
  if (window <= 0) return Number.POSITIVE_INFINITY
  if (buffer !== undefined) return window - buffer
  if (keepFreePercent !== undefined) return window - Math.floor(window * (keepFreePercent / 100))
  return window - Math.max(Math.floor(window * 0.1), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
}

/**
 * Another provider's count may describe a native window this model cannot replay. History then holds the original
 * messages that window stood for, which the count leaves out, so only the current provider's counts are trusted.
 */
const hasMeasuredPrompt = (message: SessionMessage.Info, model: SessionContext.Loaded["model"]["ref"]) =>
  message.type === "assistant" &&
  message.model.providerID === model.providerID &&
  !message.error &&
  message.tokens !== undefined &&
  message.tokens.input + message.tokens.cache.read + message.tokens.cache.write > 0

const estimateRequest = (request: Pick<LLMRequest, "system" | "tools" | "messages">) =>
  request.system.reduce((sum, part) => sum + Token.estimate(part.text), 0) +
  request.tools.reduce((sum, tool) => sum + estimateTool(tool), 0) +
  request.messages.reduce((sum, message) => sum + estimateMessage(message), 0)

const toolTokenCache = new WeakMap<ToolEntry, number>()

/** Only what providers receive; `metadata` and `native` stay local. */
const estimateTool = (tool: ToolEntry): number => {
  const cached = toolTokenCache.get(tool)
  if (cached !== undefined) return cached
  let total = 0
  if (tool.type === "tool") {
    const schemaStr = JSON.stringify(tool.inputSchema) ?? ""
    total = Token.estimateChars(tool.name.length + (tool.description?.length ?? 0) + schemaStr.length)
  } else {
    const header = Token.estimateChars(tool.name.length + (tool.description?.length ?? 0))
    total = header + tool.tools.reduce((sum, entry) => sum + estimateTool(entry), 0)
  }
  toolTokenCache.set(tool, total)
  return total
}

const messageTokenCache = new WeakMap<Message, number>()

const estimateMessage = (message: Message) => {
  const cached = messageTokenCache.get(message)
  if (cached !== undefined) return cached
  const total = message.content.reduce((sum, part) => sum + estimatePart(part), 0)
  messageTokenCache.set(message, total)
  return total
}

const estimatePart = (part: ContentPart): number => {
  // An encrypted native compaction has no locally measurable size.
  if (part.type === "compaction") return Token.estimate(part.text ?? "")
  if (part.type === "effort") return 0
  if (part.type === "text" || part.type === "reasoning") return Token.estimate(part.text)
  if (part.type === "media") return estimateMedia(part.media.mediaType)
  if (part.type === "tool-call") {
    const inputStr = typeof part.input === "string" ? part.input : (JSON.stringify(part.input) ?? "")
    return Token.estimateChars(part.name.length + inputStr.length)
  }

  if (part.result.type === "content")
    return part.result.value.reduce(
      (sum, content) => sum + (content.type === "text" ? Token.estimate(content.text) : estimateMedia(content.mime)),
      0,
    )
  const value = part.result.value
  if (typeof value === "string") return Token.estimate(value)
  const json = JSON.stringify(value) ?? ""
  return Token.estimateChars(json.length)
}

const estimateMedia = (mime: string) => {
  const type = mime.toLowerCase()
  if (type.startsWith("image/")) return IMAGE_TOKEN_ESTIMATE
  if (type === "application/pdf") return PDF_TOKEN_ESTIMATE
  return 0
}
