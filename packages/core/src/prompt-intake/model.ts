export * as PromptIntakeModel from "./model.js"

import { Duration, Effect, Option } from "effect"
import { LLMClient, Message, SystemPart } from "@orchestra/ai"
import { Model } from "../model.js"
import { ModelResolver } from "../model-resolver.js"
import { Provider } from "../provider.js"
import { SessionContext } from "../session/context.js"
import type { SessionSchema } from "../session/schema.js"
import type { Disambiguation, StructuredTask } from "./types.js"

/**
 * Cheap models only, in preference order. Never the session's model (which
 * may be an expensive reasoning model) and never an expensive model from
 * the catalog. When none of these resolve, the model step is skipped and
 * the heuristic reading stands — a missing cheap model is not a reason to
 * burn an expensive one.
 */
export const CHEAP_MODEL_PREFERENCE: ReadonlyArray<{ providerID: string; id: string }> = [
  { providerID: "lix", id: "deepseek-v4.1-flash" },
  { providerID: "anymodel", id: "gemini-3.8-flash" },
]

const SYSTEM =
  "You disambiguate a user's task for an AI agent. Answer ONLY with JSON: {\"assumptions\": [\"...\"], \"clarifiedGoal\": \"...\"}. " +
  "At most 3 assumptions, each one short sentence. clarifiedGoal is optional: set it only when the goal is clearly misstated. No other text."

export type Disambiguator = (input: {
  session: SessionSchema.Info
  task: StructuredTask
}) => Effect.Effect<Disambiguation, never>

function heuristic(task: StructuredTask): Disambiguation {
  return {
    assumptions: task.ambiguities.map((ambiguity) => ambiguity.assumption),
    modelUsed: false,
  }
}

function parseDisambiguation(text: string): Disambiguation | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      assumptions?: unknown
      clarifiedGoal?: unknown
    }
    if (!Array.isArray(parsed.assumptions)) return undefined
    const assumptions = parsed.assumptions.filter((item): item is string => typeof item === "string").slice(0, 3)
    if (assumptions.length === 0) return undefined
    return {
      assumptions,
      clarifiedGoal: typeof parsed.clarifiedGoal === "string" ? parsed.clarifiedGoal : undefined,
      modelUsed: true,
    }
  } catch {
    return undefined
  }
}

/**
 * One short model call to resolve the ambiguities the heuristics found.
 * Never throws: any failure (no cheap model, no credentials, a timeout,
 * unparsable output) falls back to the heuristic assumptions.
 */
export const disambiguateWithModel = Effect.fn("PromptIntake.disambiguateWithModel")(function* (
  input: { session: SessionSchema.Info; task: StructuredTask },
) {
  return yield* Effect.gen(function* () {
    const models = yield* Model.Service
    const resolver = yield* ModelResolver.Service
    let resolved: ModelResolver.Resolved | undefined
    for (const preference of CHEAP_MODEL_PREFERENCE) {
      const info = yield* models.get(Provider.ID.make(preference.providerID), Model.ID.make(preference.id))
      if (!info) continue
      const candidate = yield* resolver.resolveModel(info).pipe(Effect.option)
      if (Option.isSome(candidate)) {
        resolved = candidate.value
        break
      }
    }
    if (!resolved) return heuristic(input.task)

    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id)
    const prompt = [
      `Task goal: ${input.task.goal}`,
      "Ambiguities:",
      ...input.task.ambiguities.map((ambiguity) => `- ${ambiguity.question}`),
      `Context: ${input.task.context.join(" ") || "none"}`,
    ].join("\n")
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model: resolved,
      tools: selection.tools,
      system: [SystemPart.make(SYSTEM)],
      messages: [Message.user(prompt)],
    })
    const llm = yield* LLMClient.Service
    const response = yield* llm.generate(prepared.request, prepared.options)
    return parseDisambiguation(response.text) ?? heuristic(input.task)
  }).pipe(
    Effect.timeout(Duration.toMillis("30 seconds")),
    Effect.catchCause(() => Effect.succeed(heuristic(input.task))),
  )
})
