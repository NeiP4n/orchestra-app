export * as SessionStep from "./step.js"

import {
  AIError,
  InvalidProviderOutputError,
  LLMClient,
  LLMEvent,
  isContextOverflowFailure,
  type ProviderErrorEvent,
  type ToolCall,
} from "@orchestra/ai"
import type { Agent } from "@orchestra/schema/agent"
import { Cause, Clock, Data, Effect, Exit, Fiber, Option, Stream } from "effect"
import { SessionError } from "@orchestra/schema/session-error"
import { Bus } from "../../bus.js"
import { Journal } from "../../journal.js"
import { Permission } from "../../permission.js"
import { Snapshot } from "../../snapshot.js"
import { Tool } from "../../tool.js"
import { ToolOutput } from "../../tool-output.js"
import { QuestionTool } from "../../tool/plugin/question.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { asRateLimit, toSessionError } from "../to-session-error.js"
import { SessionUsage } from "../usage.js"
import { SessionRequestMeasurement } from "../request-measurement.js"
import { SessionRunnerModel } from "./model.js"
import { createLLMEventPublisher } from "./publish-llm-event.js"
import { SessionRunnerRetry } from "./retry.js"
import { SessionEscalate } from "./escalate.js"

export type Outcome = Data.TaggedEnum<{
  Completed: { readonly needsContinuation: boolean }
  Retry: { readonly error: SessionError.Error; readonly decision: SessionRunnerRetry.Decision }
  Continue: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
  }
  RecoverFull: {}
  Compacted: {}
  /** The attempt moved to another model of this session and starts over on it. */
  Switched: {}
}>
export const Outcome = Data.taggedEnum<Outcome>()

/** Exported so the settle fixture drives an attempt with a fabricated tool call. */
export interface Input {
  readonly isLocationClosed: () => boolean
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly prepared: Omit<SessionModelRequest.Prepared, "event">
  readonly retry: (
    cause: AIError,
    error: SessionError.Error,
    retry: boolean,
  ) => Effect.Effect<{ readonly retry: false } | SessionRunnerRetry.Decision>
  readonly recoverContinuation: boolean
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  readonly recoverOverflow: Effect.Effect<boolean>
  /** Moves the session to its next model when the provider refuses this one outright. */
  readonly fallback: (cause: AIError, error: SessionError.Error) => Effect.Effect<boolean>
  /**
   * Best-effort L3 capture (Б17): called once per settled tool call with its
   * input and output text. The session memory module records it as an
   * observation; a failure here must never fail the step.
   */
  readonly onToolSettled?: (event: {
    readonly id: string
    readonly name: string
    readonly inputText: string
    readonly outputText: string
    readonly error?: string
  }) => Effect.Effect<void>
}

const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const

const stringifyToolInput = (input: unknown): string => {
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input) ?? String(input)
  } catch {
    return String(input)
  }
}

const toolContentText = (content: ReadonlyArray<Tool.Content>): string =>
  content.flatMap((item) => (item.type === "text" ? [item.text] : [`[file: ${item.name ?? item.mime}]`])).join("\n")

/**
 * Best-effort L3 notification: a missing callback, a synchronously throwing
 * one or a failing one is a no-op for the step. The callback is invoked
 * inside Effect.suspend: it runs while the surrounding chain is being
 * constructed, BEFORE the publisher effect it follows has run, so a
 * synchronous throw there (not only a defect in the returned effect) must
 * not escape and block the tool-result publication.
 */
const notifyToolSettled = (
  notify: Input["onToolSettled"],
  event: {
    readonly id: string
    readonly name: string
    readonly inputText: string
    readonly outputText: string
    readonly error?: string
  },
) =>
  notify === undefined
    ? Effect.void
    : Effect.suspend(() => notify(event)).pipe(
        Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void)),
      )

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const llm = yield* LLMClient.Service
  const snapshots = yield* Snapshot.Service
  const toolOutput = yield* ToolOutput.Service

  const attempt = Effect.fn("SessionStep.attempt")(function* (input: Input) {
    const startSnapshot = yield* snapshots.capture()
    const publisher = createLLMEventPublisher(bus, {
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      agent: input.agent,
      model: input.model.ref,
      providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
      snapshot: startSnapshot,
      started: yield* Clock.currentTimeMillis,
    })
    const toolRuns: Array<{
      readonly call: ToolCall
      readonly fiber: Fiber.Fiber<void, Permission.DeclinedError | QuestionTool.CancelledError>
    }> = []
    const interruptTools = Effect.suspend(() => Fiber.interruptAll(toolRuns.map((run) => run.fiber)))

    // Settle this step's measured attempt (Step 0). Idempotent and best-effort inside: safe to
    // call on every branch, and a failure here can never change the step's own outcome. The
    // attempt identity travels with Prepared, not with session-global state; without it there
    // is nothing to settle (measurement off or its hook failed).
    const settleMeasurement = (outcome: "completed" | "failed" | "cancelled") =>
      Effect.suspend(() =>
        input.prepared.measurement === undefined
          ? Effect.void
          : SessionRequestMeasurement.completePrimary(
              input.sessionID,
              { outcome, endedAt: Date.now() },
              { attemptID: input.prepared.measurement.attemptID },
            ),
      )
    const executeTool = (call: ToolCall) => {
      if (input.prepared.request.toolChoice?.type === "none")
        return new Tool.Error({ message: "Tools are disabled after the maximum agent steps" })
      return input.prepared.executeTool({
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.assistantMessageID,
        call,
        progress: (update) => publisher.progress(call.id, update),
      })
    }

    // Provider and tool fibers retain per-source order without a shared writer queue.
    // A local execution starts only after its Tool.Called publication completes.
    let overflowFailure: ProviderErrorEvent | undefined
    // Read to the end, not just the finish event, so the next request can reuse this response.
    const providerStream = llm.stream(input.prepared.request, input.prepared.options).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (overflowFailure || publisher.hasProviderError()) return
          if (
            LLMEvent.is.providerError(event) &&
            isContextOverflowFailure(event) &&
            !publisher.record().outputStarted
          ) {
            overflowFailure = event
            return
          }
          yield* publisher.publish(event)
          if (event.type !== "tool-call" || event.providerExecuted) return
          toolRuns.push({
            call: event,
            fiber: yield* Effect.uninterruptibleMask((restore) =>
              restore(executeTool(event)).pipe(
                Effect.flatMap(toolOutput.truncate),
                Effect.flatMap((outcome) =>
                  publisher.toolExecution(event.id, event.name, outcome).pipe(
                    Effect.andThen(
                      notifyToolSettled(input.onToolSettled, {
                        id: event.id,
                        name: event.name,
                        inputText: stringifyToolInput(event.input),
                        outputText: toolContentText(outcome.content),
                      }),
                    ),
                  ),
                ),
                Effect.catchTag("Tool.Error", (error) =>
                  publisher.failTool(event.id, toSessionError(error), error.metadata).pipe(
                    Effect.andThen(
                      notifyToolSettled(input.onToolSettled, {
                        id: event.id,
                        name: event.name,
                        inputText: stringifyToolInput(event.input),
                        outputText: "",
                        error: error.message,
                      }),
                    ),
                    Effect.asVoid,
                  ),
                ),
              ),
            ).pipe(Effect.forkScoped),
          })
        }),
      ),
      Effect.ensuring(publisher.flush()),
    )

    // Keep the final tool and Step events uninterruptible, even when the work itself is cancelled.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const stream = yield* restore(providerStream).pipe(Effect.exit)
        const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
        const streamInterrupted = Exit.hasInterrupts(stream)
        if (!overflowFailure && publisher.hasStarted()) yield* publisher.streamed()
        if (streamInterrupted) yield* interruptTools
        const joined = yield* restore(Fiber.awaitAll(toolRuns.map((run) => run.fiber))).pipe(Effect.exit)
        if (Exit.isFailure(joined)) yield* interruptTools
        const tools = classifyToolExits(joined, toolRuns)

        const overflow = overflowFailure ?? streamFailure
        if (
          !publisher.record().outputStarted &&
          isContextOverflowFailure(overflow) &&
          (yield* restore(input.recoverOverflow))
        ) {
          yield* Effect.logWarning("provider rejected the request as too long; compacting", {
            sessionID: input.sessionID,
            model: input.model.ref,
            message: overflow?.message,
          })
          yield* settleMeasurement("failed")
          return Outcome.Compacted()
        }

        if (overflowFailure) yield* publisher.publish(overflowFailure)
        const recorded = publisher.record()
        const unknownFinish =
          Exit.isSuccess(stream) && recorded.finish?.finish === "unknown"
            ? new AIError({
                reason: new InvalidProviderOutputError({
                  message: "The provider response ended with an unknown finish reason.",
                  classification: "incomplete-stream",
                }),
              })
            : undefined
        const llmFailure = streamFailure instanceof AIError ? asRateLimit(streamFailure) : unknownFinish
        const llmError = llmFailure && !recorded.providerFailed ? toSessionError(llmFailure) : undefined
        if (
          input.recoverContinuation &&
          llmFailure?.reason._tag === "Transport" &&
          (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
          !recorded.outputStarted
        ) {
          yield* settleMeasurement("failed")
          return Outcome.RecoverFull()
        }
        const retry =
          llmFailure && llmError && !isContextOverflowFailure(llmFailure)
            ? yield* restore(
                input.retry(
                  llmFailure,
                  llmError,
                  SessionRunnerRetry.isRetryable(llmFailure) ||
                    (recorded.outputStarted && isInterruptedStream(llmFailure)),
                ),
              )
            : undefined
        if (llmFailure && llmError && retry?.retry && !recorded.outputStarted) {
          // Retry state projects onto the existing assistant, even before it has produced output.
          yield* publisher.startAssistant()
          yield* settleMeasurement("failed")
          return Outcome.Retry({ error: llmError, decision: retry })
        }
        // Another model is the only way forward when waiting cannot help, so a worker moves on
        // instead of failing the task. Nothing was produced yet, so the new attempt is clean.
        if (llmFailure && llmError && !retry?.retry && !recorded.outputStarted) {
          if (yield* restore(input.fallback(llmFailure, llmError))) {
            yield* settleMeasurement("failed")
            return Outcome.Switched()
          }
        }
        // Retries and fallbacks are exhausted: the failure is announced in the session itself
        // (escalation ladder, block Б5) instead of failing silently into the log. The
        // orchestrator reads it as its next instruction; the society/president rung is
        // decided by the ladder, not by waiting for a human.
        if (llmFailure && llmError && retry !== undefined && !retry.retry)
          yield* SessionEscalate.announce({
            bus,
            sessionID: input.sessionID,
            cause: llmFailure,
            escalation: SessionEscalate.ladder({ cause: llmFailure, limitsExhausted: true }),
          })
        if (llmError) yield* publisher.failAssistant(llmError)

        for (const decline of tools.declines)
          yield* publisher.failTool(decline.call.id, {
            type: "aborted",
            message: input.isLocationClosed()
              ? "Interaction cancelled because the location shut down"
              : decline.reason._tag === "QuestionTool.CancelledError"
                ? decline.reason.message
                : "The user declined this tool call",
          })
        const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
        const toolFailure = interrupted
          ? TOOLS_INTERRUPTED
          : tools.failure !== undefined
            ? toSessionError(Cause.squash(tools.failure))
            : recorded.providerFailed
              ? TOOLS_INTERRUPTED
              : undefined
        if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
        if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)
        // The receipt for a break after output started: the partial text is
        // already flushed durably and the step failed, so the only thing left
        // is to say so in the error journal instead of leaving silence.
        if (publisher.record().outputStarted && (interrupted || llmError !== undefined))
          yield* Journal.recordError({
            source: "session-runner",
            kind: "stream-interrupted",
            message: llmError?.message ?? "Step interrupted after output started",
            sessionID: input.sessionID,
          })

        // All local fibers have joined; only provider-hosted results can still be missing.
        if (llmError || (Exit.isSuccess(stream) && !recorded.providerFailed)) {
          const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
          if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
        }

        const record = publisher.record()
        const usage = record.finish
          ? { cost: SessionUsage.calculateCost(input.model.cost, record.finish.tokens), tokens: record.finish.tokens }
          : undefined
        if (record.finish || record.failure) {
          const snapshot = yield* snapshots.capture()
          const files =
            startSnapshot && snapshot
              ? startSnapshot === snapshot
                ? []
                : yield* snapshots
                    .files({ from: startSnapshot, to: snapshot })
                    .pipe(Effect.orElseSucceed(() => undefined))
              : undefined
          if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
          if (record.finish && usage && !record.failure)
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: input.sessionID,
              assistantMessageID: yield* publisher.startAssistant(),
              finish: record.finish.finish,
              rawFinish: record.finish.rawFinish,
              providerState: record.finish.providerState,
              ...usage,
              snapshot,
              files,
            })
        }

        // Settle the measured attempt for this step: completed with the SessionUsage-normalized
        // tokens and the catalog-estimated cost, cancelled on interruption, failed on an LLM or
        // step failure (usage stays unknown then). Early-return branches above settle their own
        // attempts; this covers every path that reaches the end. Diagnostic only; never a second
        // source of charges.
        if (SessionRequestMeasurement.enabled()) {
          const outcome = record.finish && !record.failure ? "completed" : interrupted ? "cancelled" : "failed"
          if (outcome === "completed" && usage && record.finish && input.prepared.measurement !== undefined) {
            // Unknown stays unknown in the diagnostic record: only usage fields the provider
            // actually reported become numbers, read from the optional raw fields - not the
            // zero-filled getters billing normalization uses. output excludes reasoning (the
            // same non-overlapping convention as billing's visible output), so summing the
            // fields never double-counts. A cost is estimated only when usage is complete for
            // pricing (all four cost-driving fields reported) AND an applicable price tier
            // exists: a free tier estimates to 0; partial usage or a missing price stays null.
            const raw = record.finish.rawUsage
            const field = (value: number | undefined) =>
              typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
            const completeUsage =
              raw !== undefined &&
              raw.nonCachedInputTokens !== undefined &&
              raw.outputTokens !== undefined &&
              raw.cacheReadInputTokens !== undefined &&
              raw.cacheWriteInputTokens !== undefined
            const priced = completeUsage && SessionUsage.hasPrice(input.model.cost, usage.tokens)
            yield* SessionRequestMeasurement.completePrimary(
              input.sessionID,
              {
                outcome,
                endedAt: Date.now(),
                usage:
                  raw === undefined
                    ? { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null }
                    : {
                        input: field(raw.nonCachedInputTokens),
                        // Visible output only when the total/reasoning split is fully known;
                        // a missing split leaves output unknown instead of inflating it.
                        output:
                          raw.outputTokens === undefined || raw.reasoningTokens === undefined
                            ? null
                            : Math.max(0, raw.outputTokens - raw.reasoningTokens),
                        reasoning: field(raw.reasoningTokens),
                        cacheRead: field(raw.cacheReadInputTokens),
                        cacheWrite: field(raw.cacheWriteInputTokens),
                      },
                cost: {
                  recordedUSD: null,
                  estimatedUSD: priced ? usage.cost : null,
                  source: priced ? "catalog" : "unknown",
                },
              },
              { attemptID: input.prepared.measurement.attemptID },
            )
          } else yield* settleMeasurement(outcome)
        }

        if (
          llmFailure &&
          llmError &&
          retry?.retry &&
          record.outputStarted &&
          tools.declines.length === 0 &&
          !tools.interrupted
        )
          return Outcome.Continue({ error: llmError, decision: retry })

        if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
        if (tools.declines.length > 0) {
          if (input.isLocationClosed()) return Outcome.Completed({ needsContinuation: true })
          return yield* Effect.interrupt
        }
        if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
        if (tools.interrupted && Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
        if (record.failure) return yield* new StepFailedError({ error: record.failure })
        return Outcome.Completed({
          needsContinuation: input.prepared.request.toolChoice?.type !== "none" && record.needsContinuation,
        })
      }).pipe(
        // A defect or fiber-level interrupt escapes the branches above; settle the attempt as
        // failed/cancelled so it never stays open. Already-settled attempts are untouched.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : settleMeasurement(Exit.hasInterrupts(exit) ? "cancelled" : "failed"),
        ),
      ),
    )
  }, Effect.scoped)

  return { attempt }
})

const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
const classifyToolExits = (
  settled: Exit.Exit<Array<Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>>>,
  runs: ReadonlyArray<{ readonly call: ToolCall }>,
) => {
  const exits = Exit.isSuccess(settled) ? settled.value : []
  const declines = exits.flatMap((exit, index) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: runs[index].call, reason: reason.error }] : [],
        )
      : [],
  )
  const causes = Exit.isFailure(settled)
    ? [settled.cause]
    : exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: causes.some(Cause.hasInterrupts), declines, failure }
}
