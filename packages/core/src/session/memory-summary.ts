export * as SessionMemorySummary from "./memory-summary.js"

import { LLMClient, Message, SystemPart } from "@orchestra/ai"
import { Effect } from "effect"
import { Instance } from "../instance/service.js"
import { SessionMemory } from "../memory/session.js"
import { Model } from "../model.js"
import { Plugin } from "../plugin/service.js"
import { SessionContext } from "./context.js"
import { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"

/**
 * Stop summary through the cheapest model that can do trivial work (B10
 * router, tier `trivial`). Mirrors `SessionGenerate.generate`, but resolves
 * the picked cheap model instead of the session's own model.
 *
 * This is best-effort by design: it needs the model catalog, the runner
 * model resolver and an LLM client in scope. When any of them is missing (or
 * the call fails or times out) the caller — `SessionMemory.finalizeSession` —
 * falls back to the extractive summary, so a Stop summary never fails a stop.
 */
export const summarize = Effect.fn("SessionMemorySummary.summarize")(function* (input: {
  session: SessionSchema.Info
  prompt: string
}) {
  yield* Plugin.awaitActivation
  const instances = yield* Instance.Service

  return yield* Effect.gen(function* () {
    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id)
    const catalog = yield* Model.Service
    const available = yield* catalog.available()
    const picked = SessionMemory.pickSummaryModel(available)
    if (!picked.providerID) return yield* Effect.fail(new Error("SessionMemorySummary: picked model has no provider"))
    const models = yield* SessionRunnerModel.Service
    const model = yield* models.resolve(
      {
        ...selection.session,
        model: Model.Ref.parse(
          `${picked.providerID}/${picked.id}${picked.variant ? `#${picked.variant}` : ""}`,
        ),
      },
      catalog.available,
    )
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: [
        SystemPart.make(
          "You summarize a finished agent session into its memory file. Keep it short and concrete: decisions first, then lessons, then other changes. End with: What works / What does not work / Next step.",
        ),
      ],
      messages: [Message.user(input.prompt)],
    })
    const llm = yield* LLMClient.Service
    const response = yield* llm.generate(prepared.request, prepared.options)
    return response.text
  }).pipe(instances.provide(input.session))
})
