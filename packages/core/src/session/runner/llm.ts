import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
export * as SessionRunnerLLM from "./llm.js"

import { Message, ProviderCooldown, isContextOverflowFailure } from "@orchestra/ai"
import type { AIError } from "@orchestra/ai"
import { Mode } from "@orchestra/schema/mode"
import { Orchestra } from "@orchestra/schema/orchestra"
import { SessionError } from "@orchestra/schema/session-error"
import { and, desc, eq, sql } from "drizzle-orm"
import { Cause, Clock, DateTime, Duration, Effect, Exit, FiberMap, Layer, Option } from "effect"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import type { Entry } from "@orchestra/schema/config"
import { Model } from "../../model.js"
import { AiStandard } from "../../ai-standard.js"
import { LocationLifecycle } from "../../location-lifecycle.js"
import { InstructionState } from "../instruction-state.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionHistory } from "../history.js"
import { SessionProviderContext } from "../provider-context.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionRequestMeasurement } from "../request-measurement.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { SessionMessageTable } from "../sql.js"
import { SessionTitle } from "../title.js"
import { toSessionError } from "../to-session-error.js"
import { DrainResult, Service, type Interface } from "./index.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { llmClient } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import { mainSessionFallbackChain } from "./error-taxonomy.js"
import { SessionStep } from "./step.js"
import { ToolOutput } from "../../tool-output.js"
import { ToolPruning } from "../tool-pruning.js"
import { Plugin } from "../../plugin.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"
import { Limits } from "../../limits.js"
import { Dod } from "../../dod.js"
import { Location } from "../../location.js"
import { SessionMemory } from "../../memory/session.js"
import { scrubText } from "../../memory/scrub.js"
import { SessionCompletionGate } from "../completion-gate.js"
import { RuleEnforce } from "../../rule-enforce.js"

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

/** How many times auto-compaction may complete inside one step before the step fails instead of looping. */
const MAX_AUTO_COMPACTIONS_PER_STEP = 3

/**
 * L3 session memory capture for one settled tool call (Б17): the exact
 * callback the runner wires as onToolSettled, exported so the settle fixture
 * drives the production wiring. Never throws and never fails the step: the
 * engine opens eagerly, so a build without the Bun sqlite engine cannot
 * construct it, and an operational open failure (permissions, lock, damaged
 * database) must not fail the settle either. The scrubbed file journal stays
 * the record in both cases; the warning distinguishes a permanently missing
 * capability (once per directory) from a retryable operational failure (once
 * per failure streak, the open is retried on the next settled tool call).
 */
export const toolSettledCapture =
  (directory: string, sessionID: SessionSchema.ID, scrub: (text: string) => string) =>
  (event: {
    readonly id: string
    readonly name: string
    readonly inputText: string
    readonly outputText: string
    readonly error?: string
  }): Effect.Effect<void> =>
    Effect.suspend(() => {
      const opened = SessionMemory.tryOpenSessionEngine(directory)
      const capture = SessionMemory.captureToolUse({
        directory,
        sessionID,
        toolUseID: event.id,
        tool: event.name,
        inputText: event.inputText,
        outputText: event.outputText,
        ...(event.error !== undefined ? { error: event.error } : {}),
        // Б17: raw tool I/O is scrubbed before it reaches the journal
        // (foundation slice `memory/scrub.ts`), never stored as-is.
        scrub,
        ...(opened.engine !== undefined ? { engine: opened.engine } : {}),
      })
      const degradation = opened.degradation
      if (degradation === undefined || !degradation.warn) return capture
      const warning =
        degradation.kind === "capability"
          ? Effect.logWarning(
              "Session memory engine is unavailable in this build; the scrubbed file journal stays the record",
              { sessionID, directory },
            )
          : Effect.logWarning(
              "Session memory engine failed to open; the scrubbed file journal stays the record and the open is retried on the next settled tool call",
              {
                sessionID,
                directory,
                error: degradation.cause instanceof Error ? degradation.cause.message : String(degradation.cause),
              },
            )
      return warning.pipe(Effect.andThen(capture))
    })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const models = yield* Model.Service
    const lifecycle = yield* LocationLifecycle.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* Plugin.Service
    const title = yield* SessionTitle.Service
    const steps = yield* SessionStep.make
    const location = yield* Location.Service
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    const drain = Effect.fn("SessionRunner.drain")(function* (input: Parameters<Interface["drain"]>[0]) {
      const sessionID = input.sessionID
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      let entering = true
      const promotable = input.promotable ?? "input"
      // The drain budget is the backstop under the per-turn step ceiling: one
      // drain (one resume) may spend at most the wall-clock/token budget in
      // `Limits`, however many turns it admits while it runs.
      const drainBudget = { startedAtMs: yield* Clock.currentTimeMillis, tokensUsed: 0 }
      // The pruning threshold is a number in config
      // (`orchestra.autoloop.toolPruneUnusedSteps`, default 10), read once per
      // drain from the location config when the context carries it — exactly
      // like the autoloop service self-configures (`ensureConfigured`).
      const toolPruneUnusedSteps = yield* readToolPruneThreshold()
      const pruneState = { lastPruned: [] as Array<string> }
      if (!force && !continuing) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        if (!pending) return DrainResult.Complete()
        const control = pending.type === "compaction" || pending.type === "move"
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      yield* plugins.awaitActivation
      yield* settleStaleCompactions(sessionID)
      yield* settleStaleToolCalls(sessionID)

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              if (lifecycle.isClosed()) {
                yield* restore(modelTransport.close(sessionID))
                return DrainResult.Reloaded({ force, continuation: continuing ? { step } : undefined })
              }
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction")
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "", inputID: next.id }],
                    ])
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              if (pending?.type === "move")
                return DrainResult.Moved({ continuation: continuing ? { step } : undefined })
              if (pending?.type === "compaction") {
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    const selected = yield* context.select(sessionID)
                    const model = yield* context.resolveModel(selected.session)
                    // Preview updates without admitting them after the already-delivered compaction marker.
                    const history = yield* SessionHistory.preview(
                      db,
                      sessionID,
                      selected.instructions,
                      SessionProviderContext.provenance(model) ?? "local",
                    )
                    return yield* compaction.compact({
                      reason: "manual",
                      inputID: pending.id,
                      context: {
                        session: selected.session,
                        agent: selected.agent,
                        tools: selected.tools,
                        model,
                        initial: history.initial,
                        messages: history.messages,
                      },
                    })
                  }).pipe(
                    Effect.catch((error) =>
                      bus.publish(SessionEvent.Compaction.Failed, {
                        sessionID,
                        reason: "manual",
                        inputID: pending.id,
                        error: toSessionError(error),
                      }),
                    ),
                  ),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer")))
                return DrainResult.Complete()
              const ready = yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  const promoted = yield* SessionInbox.promote(
                    db,
                    bus,
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                  )
                  // A control admitted during context preparation owns this boundary.
                  if (promoted === undefined) return undefined
                  if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID), {
                      onlyIfMissing: true,
                    })
                  if (promoted > 0) step = 1
                  return { _tag: "Ready" as const, context: yield* context.load(selected) }
                }),
              )
              if (ready) return ready
            }
          }),
        ),
      )

      // Models this drain already gave up, so a failing provider cannot bounce between two of
      // them across steps. The set lives for the whole drain, not one step: a refused model
      // stays refused until the next drain (a new turn) starts with a fresh set.
      const refused = new Set<string>()
      while (true) {
        const next = yield* advanceToStep()
        if (next._tag !== "Ready") return next
        const exceeded = Limits.drainBudgetExceeded(drainBudget, yield* Clock.currentTimeMillis)
        if (exceeded) return yield* failDrainBudget(sessionID, exceeded, drainBudget)
        continuing = yield* runStep(next.context, step, refused, drainBudget, toolPruneUnusedSteps, pruneState)
        // A step that finished ends the run of identical failures: two refusals in a row means in a row.
        failureSignatures.delete(refused)
        step++
        force = false
        entering = false
      }
    })

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    // The tool-pruning threshold (`orchestra.autoloop.toolPruneUnusedSteps`)
    // comes from the location config when the context carries one; without
    // it the kernel default applies. Reading it once per drain keeps the
    // per-step path free of config reads.
    const readToolPruneThreshold = Effect.fn("SessionRunner.toolPruneUnusedSteps")(function* () {
      const config = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(config)) return ToolPruning.TOOL_PRUNE_UNUSED_STEPS_DEFAULT
      const entries = yield* config.value.entries().pipe(Effect.orElseSucceed(() => [] as Array<Entry>))
      return (
        Config.latest(entries, "orchestra")?.autoloop?.toolPruneUnusedSteps ??
        ToolPruning.TOOL_PRUNE_UNUSED_STEPS_DEFAULT
      )
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    const runStep = Effect.fn("SessionRunner.runStep")(function* (
      first: SessionContext.Loaded,
      step: number,
      refused: Set<string>,
      drainBudget: { startedAtMs: number; tokensUsed: number },
      toolPruneUnusedSteps: number,
      pruneState: { lastPruned: Array<string> },
    ) {
      const sessionID = first.session.id
      let assistantMessageID = SessionMessage.ID.create()
      const retry = yield* SessionRunnerRetry.make(bus, sessionID)
      let initial: SessionContext.Loaded | undefined = first
      let recoverOverflow = true
      let recoverContinuation = true
      let autoCompactions = 0
      // Step 0 measurement: retry identity for the NEXT attempt, set only when this attempt's
      // outcome is an actual retry/recovery (Retry/RecoverFull/Compacted/Switched). A Completed
      // or Continue outcome starts a new logical request; linkage is never inferred.
      let measurementRetryOf: SessionRequestMeasurement.RetryToken | undefined
      // The current model is refused from the start, so a fallback never picks it back.
      refused.add(modelKey(first.model.ref))
      while (true) {
        // A retry or continuation inside one step is still the same drain, so
        // the budget is checked on every attempt, not just between steps.
        const exceeded = Limits.drainBudgetExceeded(drainBudget, yield* Clock.currentTimeMillis)
        if (exceeded) return yield* failDrainBudget(sessionID, exceeded, drainBudget)
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const loaded = initial ?? (yield* prepareContext(sessionID).pipe(Effect.flatMap(context.load)))
        initial = undefined
        const compacted = yield* compaction.compact({ reason: "auto", context: loaded })
        if (compacted.status === "failed") return yield* new StepFailedError({ error: compacted.error })
        if (compacted.status === "completed") {
          // Auto-compaction that keeps completing without progress would loop this step
          // forever; after a few, fail honestly so the run can retry or escalate instead.
          autoCompactions++
          if (autoCompactions > MAX_AUTO_COMPACTIONS_PER_STEP)
            return yield* new StepFailedError({
              error: {
                type: "compaction.failed",
                message: `Auto-compaction completed ${autoCompactions} times in one step without progress; stopping the step instead of looping.`,
              },
            })
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        // TokenEconomizer tool pruning, native (Б4): tools the session has
        // not called for `toolPruneUnusedSteps` turns stop being advertised
        // with every request. The decision is a pure function of visible
        // history (`ToolPruning.pruneTools`), recomputed each step; a tool
        // named in the latest user or model text comes back on the next step.
        // Execution is untouched: a pruned tool simply is not advertised,
        // and the model cannot call what it cannot see.
        const pruned = ToolPruning.pruneTools(loaded.tools, loaded.messages, {
          unusedSteps: toolPruneUnusedSteps,
          agent: loaded.agent.id,
          protectedNames: Mode.toolsOf(loaded.session.metadata, loaded.agent.id),
        })
        if (pruned.pruned.length > 0 && pruned.pruned.join(",") !== pruneState.lastPruned.join(",")) {
          pruneState.lastPruned = [...pruned.pruned]
          yield* Effect.logInfo("session tools pruned for this step: unused tools hidden from the model request", {
            sessionID,
            pruned: pruned.pruned,
          })
        }
        const tools = pruned.tools
        // The agent's own ceiling and the mode's soft ceiling both apply; the smaller one wins.
        // An agent with no steps of its own falls back to the single AI standard's budget for
        // its effort class (AiStandard.stepCeilings); the standard never lowers a set ceiling.
        const agentSteps = loaded.agent.info.steps
        const modeSteps = Mode.stepsOf(loaded.session.metadata)
        const stepLimit = Limits.steps(
          AiStandard.stepCeilings({
            agentSteps,
            modeSteps,
            effort: AiStandard.effortFor(`${loaded.agent.info.id} ${loaded.agent.info.name}`),
          }),
        )
        const stepLimitReached = stepLimit !== undefined && step >= stepLimit
        const transcript = SessionModelRequest.baseTranscript({
          agent: loaded.agent.info,
          model: loaded.model,
          tools,
          initial: loaded.initial,
          messages: loaded.messages,
        })
        // The prompt estimate is the drain's token spend: measured tokens the
        // provider already reported plus the text since, counted once per
        // request so a looping model cannot hide behind a stale anchor.
        const promptEstimate = SessionCompaction.estimatePrompt(loaded)
        drainBudget.tokensUsed += promptEstimate.measured + promptEstimate.estimated
        const prepared = yield* context.request.primary({
          session: loaded.session,
          agent: loaded.agent.id,
          model: loaded.model,
          tools,
          system: transcript.system,
          measurementRetryOf,
          // The request must end with a user message: Claude (Anthropic, Vertex, Antigravity) and others refuse an
          // assistant message last ("does not support assistant message prefill", 400), and every fallback model
          // refuses it the same way. The step-limit notice is therefore a user message, and a history that still
          // ends on an assistant message gets a short user line.
          messages: [
            ...endOnUser(stepLimitReached ? [...transcript.messages, Message.user(MAX_STEPS_PROMPT)] : transcript.messages),
          ],
          // Keep tool definitions on the final Step to preserve the provider's cached prefix.
          toolChoice: stepLimitReached ? "none" : undefined,
          webSocket: "session",
          inputTokens: promptEstimate,
        })
        const outcome = yield* steps.attempt({
          isLocationClosed: lifecycle.isClosed,
          sessionID,
          assistantMessageID,
          agent: loaded.agent.id,
          model: loaded.model,
          prepared,
          // L3 session memory (Б17): one observation per settled tool call.
          // The engine opens lazily on the first tool use (process-wide
          // cache in SessionMemory), so a step that never touches a tool
          // never creates the session memory database.
          onToolSettled: toolSettledCapture(location.project.directory, sessionID, scrubText),
          retry: (cause, error, proposed) =>
            retry.decide({
              cause,
              error,
              agent: loaded.agent.id,
              model: loaded.model.ref,
              hook: prepared.retry,
              retry: proposed,
            }),
          recoverContinuation,
          fallback: (cause, error) => nextModel(loaded, cause, error, refused),
          recoverOverflow: Effect.suspend(() =>
            recoverOverflow && compaction.getSettings().auto
              ? compaction
                  .compact({ reason: "overflow", context: loaded })
                  .pipe(Effect.map((result) => result.status === "completed"))
              : Effect.succeed(false),
          ),
        })
        // A completed step is session activity even when the model never touched `dod`:
        // renew the leases this session holds, so a long run does not lose its items at
        // the five-minute mark. The name mirrors DodTool.ownerOf. Best-effort: a board
        // write must never fail the step, and a project without a board renews nothing.
        yield* Dod.heartbeatHeld({
          directory: location.project.directory,
          owner: { id: sessionID, name: `AI ${sessionID.slice(-8)}` },
        }).pipe(Effect.ignore)
        measurementRetryOf =
          outcome._tag === "Retry" ||
          outcome._tag === "RecoverFull" ||
          outcome._tag === "Compacted" ||
          outcome._tag === "Switched"
            ? prepared.measurement
            : undefined
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          Completed: (outcome) => Effect.succeed(outcome.needsContinuation),
          Retry: (outcome) =>
            retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            }),
          Continue: Effect.fnUntraced(function* (outcome) {
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            assistantMessageID = SessionMessage.ID.create()
          }),
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
          }),
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
          }),
          Switched: Effect.fnUntraced(function* () {
            assistantMessageID = SessionMessage.ID.create()
          }),
        })
        if (completed === false) {
          // The run would go idle: hold the session to what it took on before letting it stop.
          const nudge = SessionCompletionGate.check(
            yield* store.context(sessionID),
            yield* Dod.status(location.project.directory),
            yield* DateTime.now,
            sessionID,
            undefined,
            loaded.agent.id,
          )
          if (nudge) {
            yield* bus.publish(SessionEvent.Synthetic, {
              sessionID,
              text: nudge,
              description: "Completion check",
              metadata: { [SessionCompletionGate.MetadataKey]: true },
            })
            return true
          }
          // The soft layer of the rulebook: a light judge reads the finished turn against the free-text rules this
          // session carries and sends it back to work with the rule quoted. At most JUDGE_MAX times per operator turn;
          // any failure of the judge lets the turn end.
          if (title.ask) {
            const judged = yield* Effect.gen(function* () {
              const rules = RuleEnforce.recall(String(sessionID)).filter((entry) => !RuleEnforce.isDirective(entry.text))
              if (rules.length === 0) return undefined
              const messages = yield* store.context(sessionID)
              if (SessionCompletionGate.judgedCount(messages, RuleEnforce.JUDGE_KEY) >= RuleEnforce.JUDGE_MAX) return undefined
              const digest = SessionCompletionGate.turnDigest(messages)
              const line = yield* title
                .ask!({ sessionID, system: RuleEnforce.JUDGE_SYSTEM, text: RuleEnforce.judgePrompt(rules, digest) })
                .pipe(Effect.timeoutOption(Duration.seconds(25)), Effect.map(Option.getOrUndefined))
              const found = RuleEnforce.verdict(line, rules)
              RuleEnforce.log({
                layer: "soft",
                outcome: found ? "sent-back" : "passed",
                session: String(sessionID),
                agent: String(loaded.agent.id),
                ...(found ? { rule: found.entry.text, by: found.entry.by } : {}),
                what: found ? found.why : String(line ?? "no verdict"),
              })
              return found
            }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            if (judged) {
              yield* bus.publish(SessionEvent.Synthetic, {
                sessionID,
                text: `<system-reminder>\nRule check: this turn breaks a standing rule (${judged.entry.by === "operator" ? "set by the operator" : judged.entry.title}): "${judged.entry.text}". ${judged.why ? `Why: ${judged.why}. ` : ""}Fix it now, then finish. If you believe the rule does not apply, say why in one sentence.\n</system-reminder>`,
                description: "Rule check",
                metadata: { [RuleEnforce.JUDGE_KEY]: true },
              })
              return true
            }
          }
        }
        if (completed !== undefined) return completed
      }
    })

    // A worker whose provider refuses the current model outright continues on the next model
    // the operator gave it (`orchestra.worker`, or the role's own list). Those models are
    // snapshotted on the session at creation; the project's main session carries none, so it
    // falls back to the live catalog instead: other models of the same provider first, then
    // the verified Anymodel models, then lix as the second provider, then whatever else the
    // catalog has. On an authentication failure — or a gateway failure (502/503/504), which
    // is the whole provider down, not one model — the chain starts on another provider.
    // A provider with no key has no models in the catalog and contributes nothing, so a
    // fallback can never invent a provider that does not exist. A refusal, a rejected
    // request or a spent free-tier address cannot be waited out. The switch is announced
    // in the session itself: a silent model swap is an error, not a fix.
    //
    // Why this exists (Б14, 2026-11-06): G2-14 built the chain for main sessions only,
    // and `fallbackModel` refused every retryable cause — so a worker session whose
    // operator-given list was all Anymodel (Probe Runner) retried the same dead provider
    // twice on 502 and then failed, and the chain never ran. Two fixes: the live-catalog
    // chain is now appended AFTER a worker's own list, so an exhausted list crosses
    // providers; and `fallbackModel` no longer re-checks retryability — step.ts only
    // calls it after the retry policy already declined (retries spent), so a retryable
    // cause here means "change the model", not "wait again".
    const failureSignatures = new WeakMap<Set<string>, string[]>()
    const nextModel = Effect.fn("SessionRunner.nextModel")(function* (
      loaded: SessionContext.Loaded,
      cause: AIError,
      error: SessionError.Error,
      refused: Set<string>,
    ) {
      // The same error from two models in a row is the request's, not the models': stop the chain so the
      // real reason is shown instead of six fallbacks that all fail alike.
      const signature = `${cause.reason._tag}:${String(error.message ?? "").replace(/[\w-]*\d[\w-]*/g, "#").slice(0, 160)}`
      const seenErrors = failureSignatures.get(refused) ?? []
      failureSignatures.set(refused, [...seenErrors, signature])
      if (seenErrors.at(-1) === signature) {
        yield* Effect.logWarning("two models in a row failed with the same error; the fallback chain stops", {
          sessionID: loaded.session.id,
          signature,
        })
        return false
      }
      // Only the Orchestrator (or the operator) changes a team agent's model. A BrowserAgent or worker whose model fails
      // stops with the real error, which reaches the Orchestrator in the team report; it decides what to switch to.
      if (!mayFallBack(loaded.agent.id, process.env.ORCHESTRA_TEAM_MODEL_FALLBACK)) {
        yield* Effect.logWarning("a team agent does not switch models by itself; the error goes to the Orchestrator", {
          sessionID: loaded.session.id,
          agent: loaded.agent.id,
          message: error.message,
        })
        return false
      }
      const listed = Orchestra.sessionModels(loaded.session.metadata)
      // The catalog is read for every session now, not only main sessions: a
      // worker whose own list is exhausted (or all on one dead provider) falls
      // back to the live-catalog chain instead of failing on its list. A
      // catalog that cannot be read leaves the session with its list alone
      // instead of failing the drain on top of the model failure. The service
      // is bound once at the layer top: `nextModel` runs as
      // `SessionStep.attempt`'s `fallback`, whose type carries no requirements,
      // so it must not yield `Model.Service` itself.
      const catalog = yield* models.available().pipe(Effect.orElseSucceed(() => [] as readonly Model.Info[]))
      const coolingDown = new Set(
        catalog
          .map((info) => info.providerID)
          .filter((providerID) => ProviderCooldown.isCoolingDown(String(providerID))),
      )
      const mainFallbacks = mainSessionFallbackChain({
        cause,
        current: loaded.model.ref,
        catalog,
        coolingDown,
      })
      const next = fallbackModel({
        cause,
        models: [...listed, ...mainFallbacks],
        current: loaded.model.ref,
        refused,
      })
      if (!next) return false
      refused.add(modelKey(next))
      const why = `${cause.reason._tag}${cause.reason.http?.status ? ` HTTP ${cause.reason.http.status}` : ""}: ${String(error.message ?? "").slice(0, 300)}`
      try {
        appendFileSync(
          join(homedir(), "orchestra-browser-debug.log"),
          `${new Date().toISOString()} model-fallback ${loaded.model.ref.providerID}/${loaded.model.ref.id} -> ${next.providerID}/${next.id} ${why.replace(/\s+/g, " ")}\n`,
        )
      } catch {}
      yield* Effect.logWarning("the provider refused this model; the worker continues on its next model", {
        sessionID: loaded.session.id,
        model: loaded.model.ref,
        next,
        message: error.message,
      })
      if (listed.length === 0 || next.providerID !== loaded.model.ref.providerID)
        yield* bus.publish(SessionEvent.Synthetic, {
          sessionID: loaded.session.id,
          text: `Провайдер отказался от модели ${loaded.model.ref.id}; сессия продолжается на запасной модели ${next.id} (провайдер ${next.providerID}). Причина: ${why}. Это не тихая подмена: если запасная тоже откажет, ошибка уйдёт на эскалацию.`,
          description: "Model fallback",
          metadata: {
            reason: why,
            previous: `${loaded.model.ref.providerID}/${loaded.model.ref.id}`,
            next: `${next.providerID}/${next.id}`,
          },
        })
      yield* bus.publish(SessionEvent.ModelSelected, {
        sessionID: loaded.session.id,
        model: next,
        previous: loaded.session.model,
      })
      return true
    })

    const settleStaleCompactions = Effect.fn("SessionRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // A process death skips compaction finalizers. Include orphans behind a
      // completed checkpoint, and settle newest first to match event projection.
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      // A corrupt running-compaction row must not stop the settle: quarantine
      // it and settle the rows that decode, same as history loading does.
      const entries = yield* SessionHistory.decodeRows(rows, sessionID)
      for (const { message } of entries) {
        if (message.type !== "compaction") continue
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* store.context(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    // A drain that hits its wall-clock or token budget stops here, in the
    // session itself, instead of running on: the operator and the orchestrator
    // read the stop as their next instruction, and a new prompt resumes the
    // session with a fresh budget.
    const failDrainBudget = Effect.fn("SessionRunner.failDrainBudget")(function* (
      sessionID: SessionSchema.ID,
      reason: Limits.DrainBudgetExceeded,
      budget: { readonly startedAtMs: number; readonly tokensUsed: number },
    ) {
      const nowMs = yield* Clock.currentTimeMillis
      const configured = reason === "wall-clock" ? Limits.drainWallClockMs() : Limits.drainTokenBudget()
      const kind = reason === "wall-clock" ? "wall-clock" : "token"
      const spent =
        reason === "wall-clock" ? `${nowMs - budget.startedAtMs} ms` : `${budget.tokensUsed} estimated prompt tokens`
      const tune = reason === "wall-clock" ? "ORCHESTRA_DRAIN_WALL_CLOCK_MS" : "ORCHESTRA_DRAIN_TOKEN_BUDGET"
      const message = `Session drain stopped: ${kind} budget of ${configured} reached (${spent} spent). The session stopped instead of running on; send a new prompt to resume it with a fresh budget, or raise ${tune}. Limits can be switched off entirely with ORCHESTRA_DISABLE_LIMITS=1, which is not recommended for live runs.`
      yield* bus.publish(SessionEvent.Synthetic, {
        sessionID,
        text: message,
        description: "Drain limit reached",
      })
      yield* Effect.logWarning("session drain stopped at its limit instead of running on", {
        sessionID,
        reason,
        spent,
        budget: configured,
      })
      return yield* new StepFailedError({ error: { type: "limit.reached", message } })
    })

    return Service.of({ drain })
  }),
)

const modelKey = (model: Model.Ref) => `${model.providerID}/${model.id}#${model.variant ?? ""}`

/** A model without its variant: `sonnet-5` and `sonnet-5#max` are the same model. */
const modelIdentity = (model: Model.Ref) => `${model.providerID}/${model.id}`

/** `refused` holds full keys (`provider/id#variant`); a refusal is per model, not per variant. */
const refusedIdentities = (refused: ReadonlySet<string>) => new Set([...refused].map((key) => key.split("#")[0] ?? key))

/** A team agent (agent id "team-...") never switches model on its own unless the operator turns it on. */
export const mayFallBack = (agent: string, flag: string | undefined) => !String(agent).startsWith("team-") || flag === "1"

/** A provider-safe tail: the last message is never the assistant's. */
export function endOnUser<T extends { readonly role: string }>(messages: ReadonlyArray<T>): ReadonlyArray<T> {
  const last = messages.at(-1)
  return last?.role === "assistant" ? [...messages, Message.user("Continue.") as unknown as T] : messages
}

/**
 * The next model a session may try after its provider refused the current one outright. This
 * runs ONLY after the retry policy already declined (see `step.ts`: the fallback is called
 * when `retry` is false — the retries are spent or the cause never retries), so a retryable
 * cause here means "change the model", not "wait again": re-checking retryability here is
 * what left a 502 to fail a worker session after two same-model retries instead of crossing
 * providers (Б14 Probe Runner). A content policy refusal belongs to the request, not to the
 * model, so another model would only dodge the filter. A context overflow that survived
 * compaction is the task's own size: another model hides it instead of reporting it, so the
 * step fails honestly. The candidate list is the operator-given list first, then the
 * live-catalog chain (`mainSessionFallbackChain`; `anymodel-v4.1-flash` is dead and never
 * listed). The current model is excluded by identity, not by variant: another variant of
 * the same model is the same model, and on an authentication failure it fails exactly the
 * same way.
 */
export function fallbackModel(input: {
  readonly cause: AIError
  readonly models: ReadonlyArray<Model.Ref>
  readonly current: Model.Ref
  readonly refused: ReadonlySet<string>
}) {
  if (input.cause.reason._tag === "ContentPolicy") return undefined
  if (isContextOverflowFailure(input.cause)) return undefined
  const refusedModels = refusedIdentities(input.refused)
  const current = modelIdentity(input.current)
  return input.models.find((model) => !refusedModels.has(modelIdentity(model)) && modelIdentity(model) !== current)
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    LocationLifecycle.node,
    llmClient,
    Model.node,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionCompaction.node,
    Plugin.node,
    SessionTitle.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
    Location.node,
  ],
})
