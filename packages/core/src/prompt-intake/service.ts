export * as PromptIntake from "./service.js"

import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Context, Effect, Layer, Option } from "effect"
import type { SessionSchema } from "../session/schema.js"
import { Skill } from "../skill.js"
import type { Disambiguator } from "./model.js"
import { recommendSkills, valueVerdictForMarketplace, type SkillRef } from "./skills.js"
import { isTrivial, keywords } from "./normalize.js"
import type {
  Disambiguation,
  IntakeContext,
  IntakeResult,
  StructuredTask,
  ValueAssessment,
} from "./types.js"
import { understand } from "./understand.js"
import { checkValue } from "./value.js"

export interface Interface {
  /**
   * Deep-process one incoming prompt: value check first (so tokens are
   * never spent on duplicates or finished work), then the heuristic
   * structured task, then an optional cheap-model disambiguation, then
   * skill recommendations. Never fails: on any internal error the raw
   * prompt passes through with a heuristic-only result.
   */
  readonly process: (input: {
    session: SessionSchema.Info
    text: string
    context: IntakeContext
    disambiguate?: Disambiguator
  }) => Effect.Effect<IntakeResult, never>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/PromptIntake") {}

function applyDisambiguation(task: StructuredTask, disambiguation: Disambiguation): StructuredTask {
  return {
    ...task,
    goal: disambiguation.clarifiedGoal ?? task.goal,
    ambiguities: task.ambiguities.map((ambiguity, index) => ({
      ...ambiguity,
      assumption: disambiguation.assumptions[index] ?? ambiguity.assumption,
    })),
  }
}

/**
 * The result for a trivial prompt (a greeting, a thank-you, or a short
 * acknowledgement). No value check, no structured task, no model call, no
 * skill recommendations: there is nothing to structure, and the prompt
 * passes through untouched. The stored message text is the original
 * prompt; the model gets no intake note for it.
 */
function trivialResult(text: string): IntakeResult {
  const value: ValueAssessment = {
    verdict: "execute",
    confidence: 0.95,
    reasons: ["Тривиальный промпт — приветствие, благодарность или подтверждение; структурировать нечего."],
    evidence: [],
    questions: [],
    sources: { dod: false, history: false, journal: false },
  }
  return {
    original: text,
    value,
    valueVerdict: valueVerdictForMarketplace(value),
    task: {
      goal: text.trim(),
      context: [],
      constraints: [],
      dod: [],
      ambiguities: [],
      plan: [],
      keywords: keywords(text),
      needsModel: false,
    },
    skills: [],
    trivial: true,
    modelUsed: false,
  }
}

/**
 * The pure pipeline (no model, no services): value check, heuristic
 * structured task, skill recommendations from a given skill list. Used by
 * the service and by callers that have no service in scope.
 */
export function processPure(input: {
  text: string
  context: IntakeContext
  skills?: ReadonlyArray<SkillRef>
}): IntakeResult {
  if (isTrivial(input.text)) {
    return trivialResult(input.text)
  }
  const value = checkValue(input.text, input.context)
  const task = understand(input.text, input.context)
  const recommended = recommendSkills(task, input.skills ?? [])
  return {
    original: input.text,
    value,
    valueVerdict: valueVerdictForMarketplace(value),
    task,
    skills: recommended,
    trivial: false,
    modelUsed: false,
  }
}

export const process = Effect.fn("PromptIntake.process")(function* (input: {
  session: SessionSchema.Info
  text: string
  context: IntakeContext
  disambiguate?: Disambiguator
}): Effect.Effect<IntakeResult, never> {
  if (isTrivial(input.text)) {
    return trivialResult(input.text)
  }
  const value = checkValue(input.text, input.context)
  let task = understand(input.text, input.context)
  let modelUsed = false
  if (task.needsModel && (value.verdict === "execute" || value.verdict === "clarify") && input.disambiguate) {
    const disambiguation = yield* input.disambiguate({ session: input.session, task })
    if (disambiguation.modelUsed) {
      task = applyDisambiguation(task, disambiguation)
      modelUsed = true
    }
  }
  const skillService = yield* Effect.serviceOption(Skill.Service)
  const installed = Option.isSome(skillService)
    ? yield* skillService.value.list().pipe(Effect.orElseSucceed(() => [] as Array<Skill.Info>))
    : []
  const recommended = recommendSkills(task, installed)
  return {
    original: input.text,
    value,
    valueVerdict: valueVerdictForMarketplace(value),
    task,
    skills: recommended,
    trivial: false,
    modelUsed,
  }
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({ process })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [],
})
